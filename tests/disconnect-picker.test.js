import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { symlink, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { temporary, gitProject, FakeGitHub } from "./fixtures.js";
import { write, read, writeJSON, readJSON, digest } from "../packages/cli/lib/store.js";
import { connect, disconnect, status, ENTRY } from "../packages/cli/lib/connect.js";
import { Runtime, stateFile } from "../packages/cli/lib/runtime.js";
import { chatPreviews, firstSentence, displayText } from "../packages/cli/lib/previews.js";
import { disconnectChoices, disconnectPicker, selection } from "../packages/cli/lib/disconnect-picker.js";

const codexUser = (text, kinds) => ({ type: "response_item", payload: {
  type: "message", role: "user", content: [{ type: "input_text", text }],
  ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
} });
const claudeUser = (sessionId, content, extra = {}) => ({ type: "user", sessionId, message: { role: "user", content }, ...extra });
const hash = (app, id) => digest(`${app}\0${id}`);
const jsonl = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";
async function transcript(dir, app, id, records, { archived = false, metaId = id } = {}) {
  const file = app === "codex"
    ? path.join(dir, archived ? "archived_sessions" : "sessions/2026/10/12", `rollout-2026-10-12T12-00-00-${id}.jsonl`)
    : path.join(dir, "projects/local-project", `${id}.jsonl`);
  await write(file, jsonl(app === "codex" ? [{ type: "session_meta", payload: { id: metaId } }, ...records] : records));
  return file;
}

test("previews show one sentence, bound length, and remove terminal control sequences", () => {
  assert.equal(firstSentence("Fix the booking form. Then test it."), "Fix the booking form.");
  assert.equal(firstSentence("<in-app-browser-context>Injected URL.</in-app-browser-context>\n## My request:\nFix the form! Next sentence."), "Fix the form!");
  assert.equal(firstSentence("<environment_context>System context.</environment_context>"), null);
  assert.equal(firstSentence("# AGENTS.md instructions"), null);
  assert.equal(firstSentence("<local-command-stdout>output</local-command-stdout>"), null);
  assert.equal(firstSentence("x".repeat(500)).length, 160);
  assert.equal(Array.from(firstSentence("😀".repeat(500))).length, 160);
  const safe = displayText("\x1b[2JName\x1b]52;c;secret\x07\r\n\u202e visible");
  assert.equal(safe, "Name visible");
});

test("Codex preview matches exact saved identity, handles current kind tags and old records, skips injected context", async t => {
  const dir = await temporary(t), id = randomUUID(), unrelated = randomUUID(), archived = randomUUID();
  const file = await transcript(dir, "codex", id, [
    codexUser("Old task."), codexUser("Latest task. More details.", ["user.text"]),
    codexUser("Injected instructions must not appear.", ["environments.environment_context"]),
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Assistant output." }] } },
  ]);
  await transcript(dir, "codex", unrelated, [codexUser("Other project secret.")]);
  await transcript(dir, "codex", archived, [{ type: "event_msg", payload: { type: "user_message", message: "Archived task? More." } }], { archived: true });
  const wanted = new Set([hash("codex", id), hash("codex", archived)]);
  const result = await chatPreviews("codex", wanted, { CODEX_HOME: dir });
  assert.deepEqual([...result.values()].sort(), ["Archived task?", "Latest task."]);
  assert.equal(result.size, 2);
  // No native ID mismatch may show another conversation's message.
  await transcript(dir, "codex", id, [codexUser("Wrong chat.")], { metaId: unrelated });
  assert.equal((await chatPreviews("codex", new Set([hash("codex", id)]), { CODEX_HOME: dir })).size, 0);
  await unlink(file);
  assert.equal((await chatPreviews("codex", wanted, { CODEX_HOME: dir })).size, 1);
});

test("Claude previews exclude tool results, summaries, meta messages and other session IDs", async t => {
  const dir = await temporary(t), id = randomUUID();
  await transcript(dir, "claude", id, [
    claudeUser(id, "Old task."),
    claudeUser(id, [{ type: "text", text: "Build storage. Keep it small." }]),
    claudeUser(id, [{ type: "tool_result", content: "Do not show tool output." }]),
    claudeUser(id, "Do not show meta.", { isMeta: true }),
    claudeUser(id, "Do not show summary.", { isCompactSummary: true }),
    claudeUser(id, "Do not show subagent.", { isSidechain: true }),
    claudeUser(randomUUID(), "Other session."),
  ]);
  const env = { CLAUDE_CONFIG_DIR: dir }, wanted = new Set([hash("claude", id)]);
  assert.equal((await chatPreviews("claude", wanted, env)).get(hash("claude", id)), "Build storage.");
  await transcript(dir, "claude", id, [claudeUser(id, "Old task."), claudeUser(id, [{ type: "image", source: {} }])]);
  assert.equal((await chatPreviews("claude", wanted, env)).size, 0, "image-only latest message must not display stale text");
});

test("bounded transcript tails tolerate malformed/interrupted records and do not follow links", async t => {
  const dir = await temporary(t), id = randomUUID();
  const file = await transcript(dir, "codex", id, [codexUser("Very old task."), { type: "tool", text: "x".repeat(2 * 1024 * 1024) }, codexUser("Recent task. Detail.")]);
  await write(file, await read(file) + '{"incomplete":');
  const wanted = new Set([hash("codex", id)]), env = { CODEX_HOME: dir };
  assert.equal((await chatPreviews("codex", wanted, env)).get(hash("codex", id)), "Recent task.");
  await transcript(dir, "codex", id, [codexUser("Old outside tail."), { type: "tool", text: "x".repeat(2 * 1024 * 1024) }]);
  assert.equal((await chatPreviews("codex", wanted, env)).size, 0);
  if (process.platform !== "win32") {
    const other = path.join(dir, "other.jsonl");
    await write(other, jsonl([{ type: "session_meta", payload: { id } }, codexUser("Linked content.")]));
    await unlink(file);
    await symlink(other, file);
    assert.equal((await chatPreviews("codex", wanted, env)).size, 0);
  }
});

test("picker selection is explicit, deduplicated, and rejects ranges or out-of-bounds input", () => {
  assert.deepEqual(selection("2, 1 2", 2), [1, 0]);
  for (const input of ["", "q", "Quit"]) assert.deepEqual(selection(input, 2), []);
  for (const input of ["0", "3", "1.5", "all", "-1", "1-2", "1,wat", "99999999999999999999999"])
    assert.throws(() => selection(input, 2), /Choose numbers/);
});

async function setup(t) {
  const root = await gitProject(t), dir = await temporary(t), appHome = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub();
  const { file } = await connect({ cwd: root, client: "codex", repo: gh.repo, github: gh, create: true, log: () => {} });
  const runtime = new Runtime(file, { github: gh });
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    const transcript_path = await transcript(appHome, "codex", id, [codexUser(`Private task ${id}. Not for GitHub.`)]);
    await runtime.hook({ session_id: id, transcript_path, hook_event_name: "SessionStart" });
  }
  return { root, dir, gh, file, runtime, env: { CODEX_HOME: appHome }, chats: Object.values((await readJSON(stateFile(file))).chats) };
}

test("picker uses existing chats without hook updates; previews are read-only, local, and absent from normal status", async t => {
  const x = await setup(t), before = await read(stateFile(x.file)), calls = x.gh.calls;
  const { choices } = await disconnectChoices({ cwd: x.root, env: x.env });
  assert.equal(choices.length, 2);
  assert(choices.every(c => c.preview.startsWith("Private task")));
  assert(choices.every(c => !Object.hasOwn(c, "chat_key")));
  assert.equal(await read(stateFile(x.file)), before);
  assert.equal(x.gh.calls, calls, "opening the picker makes no GitHub calls");
  assert(!JSON.stringify(await status({ cwd: x.root })).includes("Private task"));
  assert(!JSON.stringify(x.gh.comments).includes("Private task"));
});

test("picker filters apps, keeps missing previews selectable, and handles an empty project", async t => {
  const x = await setup(t), id = randomUUID(), app = await temporary(t);
  const { file } = await connect({ cwd: x.root, client: "claude", repo: x.gh.repo, github: x.gh, claudeFile: path.join(app, "claude.json"), log: () => {} });
  await new Runtime(file, { github: x.gh }).hook({ session_id: id, hook_event_name: "SessionStart" });
  const env = { CODEX_HOME: path.join(app, "missing"), CLAUDE_CONFIG_DIR: app };
  const all = await disconnectChoices({ cwd: x.root, env });
  assert.equal(all.choices.length, 3);
  assert(all.choices.every(c => c.preview === null));
  assert.equal((await disconnectChoices({ cwd: x.root, client: "claude", env })).choices.length, 1);
  const answers = ["1", "y"];
  await disconnectPicker({ cwd: x.root, client: "claude", env, github: x.gh, log: () => {}, ask: async () => answers.shift() });
  const groups = await status({ cwd: x.root });
  assert(groups.find(g => g.client === "codex").chats.every(c => c.enabled));
  assert(!groups.find(g => g.client === "claude").chats[0].enabled);
  const empty = await gitProject(t), output = [];
  await disconnectPicker({ cwd: empty, env, ask: () => assert.fail("Empty picker must not prompt"), log: s => output.push(s) });
  assert.deepEqual(output, ["No local chats to disconnect."]);
});

test("cancel and invalid selection never disconnect; confirming retires only selected identities", async t => {
  const x = await setup(t), calls = x.gh.calls;
  for (const answers of [[""], ["invalid", "1", "no"]]) {
    await disconnectPicker({ cwd: x.root, env: x.env, github: x.gh, ask: async () => answers.shift(), log: () => {} });
    assert((await status({ cwd: x.root }))[0].chats.every(c => c.enabled));
    assert.equal(x.gh.calls, calls);
  }
  const answers = ["2,2", "yes"], output = [];
  await disconnectPicker({ cwd: x.root, env: x.env, github: x.gh, ask: async () => answers.shift(), log: s => output.push(s) });
  const state = (await status({ cwd: x.root }))[0];
  assert.equal(state.enabled, true);
  assert.equal(state.configured, true);
  assert.equal(state.chats[0].enabled, true);
  assert.equal(state.chats[1].enabled, false);
  await assert.rejects(x.runtime.tool("read_messages", { chat_key: x.chats[1].chat_key }), /disconnected/);
  assert(!JSON.stringify(x.gh.comments).includes("Private task"));
  assert(!output.join("\n").includes(x.chats[0].chat_key));
  assert.equal((await disconnectChoices({ cwd: x.root, env: x.env })).choices.length, 1);
});

test("offline picker retirement stays disabled and is selectable again to finish pending cleanup", async t => {
  const x = await setup(t);
  x.gh.offline = true;
  const answers = ["1 2", "y"], output = [];
  await disconnectPicker({ cwd: x.root, env: x.env, github: x.gh, ask: async () => answers.shift(), log: s => output.push(s) });
  assert((await status({ cwd: x.root }))[0].chats.every(c => !c.enabled && c.pendingRetirement));
  const { choices } = await disconnectChoices({ cwd: x.root, env: x.env });
  assert.equal(choices.length, 2);
  assert(choices.every(c => c.pendingRetirement));
  assert(output.some(s => s.includes("cleanup is pending")));
  x.gh.offline = false;
  const later = Date.now() + 16 * 60_000;
  t.mock.method(Date, "now", () => later);
  await disconnect({ cwd: x.root, agent: x.chats[0].id, github: x.gh, log: () => {} });
  assert.equal((await disconnectChoices({ cwd: x.root, env: x.env })).choices.length, 1);
});

test("connection changes while confirming stop the picker before mutation", async t => {
  const x = await setup(t);
  let n = 0;
  await assert.rejects(disconnectPicker({ cwd: x.root, env: x.env, github: x.gh, log: () => {}, ask: async () => {
    if (++n === 1) return "1";
    await writeJSON(x.file, { ...await readJSON(x.file), repo: "another/project" });
    return "y";
  } }), /connection changed/);
  assert((await status({ cwd: x.root }))[0].chats.every(c => c.enabled));
});

test("CLI picker refuses noninteractive input and incompatible flags without disconnecting anything", () => {
  for (const args of [["disconnect", "--select"], ["disconnect", "--select", "--repo", "team/repo"], ["disconnect", "--select", "--agent", "abc"], ["connect", "--select"]]) {
    const result = spawnSync(process.execPath, [ENTRY, ...args], { input: "1\ny\n", encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a terminal|Use --select only/);
  }
});
