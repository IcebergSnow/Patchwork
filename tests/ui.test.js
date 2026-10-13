import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, access, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { temporary, gitProject, FakeGitHub } from "./fixtures.js";
import { connect, disconnect, savedConnections, status, ENTRY } from "../packages/cli/lib/connect.js";
import { menu, showStatus } from "../packages/cli/lib/ui.js";
import { read, write, readJSON, writeJSON } from "../packages/cli/lib/store.js";
import { Runtime, stateFile, disabledFile } from "../packages/cli/lib/runtime.js";
import { run } from "../packages/cli/lib/github.js";

async function fixture(t) {
  const dir = await temporary(t), root = await gitProject(t), gh = new FakeGitHub();
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const env = { CODEX_HOME: path.join(dir, "codex"), CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
  const options = { cwd: root, repo: gh.repo, github: gh, create: true, log: () => {} };
  const { file } = await connect({ ...options, client: "codex" });
  const runtime = new Runtime(file, { github: gh });
  await runtime.hook({ session_id: "chat-one", transcript_path: "/test/transcript.jsonl", hook_event_name: "SessionStart" });
  const [chat] = Object.values((await readJSON(stateFile(file))).chats);
  return { dir, root, gh, env, options, file, chat };
}
function answers(values, output = []) {
  return async question => {
    output.push(question);
    assert(values.length, `Unexpected question: ${question}`);
    return values.shift();
  };
}

test("saved connections list projects and apps without network calls or private keys; invalid records are skipped", async t => {
  const x = await fixture(t), other = await gitProject(t);
  await connect({ ...x.options, cwd: other, client: "codex" });
  await connect({ ...x.options, client: "claude", claudeFile: path.join(x.dir, "claude.json") });
  const corrupt = path.join(x.dir, "connections", "a".repeat(64) + ".json");
  await write(corrupt, '{"chat_key":"DO NOT PRINT THIS"');
  const before = x.gh.calls;
  const result = await savedConnections();
  assert.equal(result.connections.length, 3);
  assert(result.connections.every(c => c.folderAvailable));
  assert.equal(result.warnings.length, 1);
  assert(!JSON.stringify(result).includes("DO NOT PRINT"));
  assert(!JSON.stringify(result).includes(x.chat.chat_key));
  assert.equal(x.gh.calls, before);
  await rm(x.root, { recursive: true });
  assert((await savedConnections()).connections.filter(c => c.root === x.root).every(c => !c.folderAvailable));
});

test("deleted project cleanup works offline, retries online, and never recreates the checkout or touches another project", async t => {
  const x = await fixture(t), other = await gitProject(t);
  const { file: otherFile } = await connect({ ...x.options, cwd: other, client: "codex" });
  const otherBefore = await read(otherFile);
  const saved = (await savedConnections()).connections.find(c => c.root === x.root);
  await rm(x.root, { recursive: true });
  x.gh.offline = true;
  await disconnect({ saved, github: x.gh, log: () => {} });
  const [pending] = await status({ saved, env: x.env });
  assert(!pending.enabled);
  assert(pending.chats[0].pendingRetirement);
  await assert.rejects(access(x.root), { code: "ENOENT" });
  assert.equal(await read(otherFile), otherBefore);
  x.gh.offline = false;
  const later = Date.now() + 16 * 60_000;
  t.mock.method(Date, "now", () => later);
  await disconnect({ saved, github: x.gh, log: () => {} });
  assert(!(await status({ saved, env: x.env }))[0].chats[0].pendingRetirement);
  assert.equal((await status({ repo: x.gh.repo, github: x.gh })).agents.find(a => a.agent_id === x.chat.id).active, false);
  await assert.rejects(access(x.root), { code: "ENOENT" });
});

test("deleted Claude project cleanup removes only its global project entry", async t => {
  const x = await fixture(t), other = await gitProject(t), claudeFile = path.join(x.dir, "claude.json");
  await connect({ ...x.options, client: "claude", claudeFile });
  await connect({ ...x.options, cwd: other, client: "claude", claudeFile });
  const otherBefore = JSON.stringify((await readJSON(claudeFile)).projects[other]);
  const saved = (await savedConnections()).connections.find(c => c.root === x.root && c.client === "claude");
  await rm(x.root, { recursive: true });
  await disconnect({ saved, github: x.gh, log: () => {} });
  const config = await readJSON(claudeFile);
  assert(!config.projects[x.root]?.mcpServers?.patchwork);
  assert.equal(JSON.stringify(config.projects[other]), otherBefore);
  await assert.rejects(access(x.root), { code: "ENOENT" });
});

test("saved selections refuse identity changes without disabling the replacement connection", async t => {
  const x = await fixture(t), [saved] = (await savedConnections()).connections;
  const c = await readJSON(x.file);
  await writeJSON(x.file, { ...c, repo: "team/replacement", repoId: 100 });
  await assert.rejects(disconnect({ saved, github: x.gh }), /connection changed/);
  await assert.rejects(status({ saved }), /connection changed/);
  assert.equal(await read(disabledFile(x.file)), "");
  assert.equal((await readJSON(x.file)).enabled, true);
});

test("menu can manage a missing project from outside Git and confirm whole-project cleanup", async t => {
  const x = await fixture(t), output = [], values = ["1", "1", "4", "2", "y", "0", "0"];
  await rm(x.root, { recursive: true });
  await menu({ cwd: x.dir, env: x.env, github: x.gh, prompt: answers(values, output), log: s => output.push(s) });
  assert.equal(values.length, 0);
  assert(output.some(s => s.includes("Folder unavailable")));
  assert(output.some(s => s.includes("Teammates on other computers stay connected")));
  assert(!(await readJSON(x.file)).enabled);
  assert(!Object.values((await readJSON(stateFile(x.file))).chats)[0].retirementPending);
  await assert.rejects(access(x.root), { code: "ENOENT" });
});

test("menu cancellation and invalid input do not disconnect; individual picker only retires selected chats", async t => {
  const x = await fixture(t), output = [];
  await new Runtime(x.file, { github: x.gh }).hook({ session_id: "chat-two", transcript_path: "/test/transcript.jsonl", hook_event_name: "SessionStart" });
  const before = await read(stateFile(x.file));
  await menu({ cwd: x.root, env: x.env, github: x.gh, prompt: answers(["bad", "4", "2", "n", "0"]), log: s => output.push(s) });
  assert.equal(await read(stateFile(x.file)), before);
  assert.equal((await readJSON(x.file)).enabled, true);
  assert(output.some(s => s.includes("Choose a number")));
  await menu({ cwd: x.root, env: x.env, github: x.gh, prompt: answers(["4", "1", "2", "y", "0"]), log: () => {} });
  const group = (await status({ cwd: x.root, env: x.env }))[0];
  assert.deepEqual(group.chats.map(c => c.enabled), [true, false]);
});

test("menu refuses a board switch during disconnect confirmation", async t => {
  const x = await fixture(t), output = [], values = ["4", "2", "y", "0"];
  const prompt = answers(values);
  await menu({ cwd: x.root, env: x.env, github: x.gh, log: s => output.push(s), prompt: async question => {
    if (question === "Disconnect this project? [y/N]") {
      const c = await readJSON(x.file);
      await writeJSON(x.file, { ...c, board: c.board + 99 });
    }
    return prompt(question);
  } });
  assert.equal(await read(disabledFile(x.file)), "");
  assert(output.some(s => s.includes("connection changed")));
});

test("guided setup confirms the detected folder/repo, reuses login and connection generators, and supports repeat installs", async t => {
  const dir = await temporary(t), root = await gitProject(t), gh = new FakeGitHub(), output = [];
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  await run("git", ["-C", root, "remote", "add", "origin", `https://github.com/${gh.repo}.git`]);
  let signIns = 0, checks = 0;
  const common = { cwd: root, github: gh, env: { CODEX_HOME: path.join(dir, "empty") }, log: s => output.push(s), signIn: async () => { signIns++; }, checkRequirements: async () => { checks++; } };
  // Connect, select Codex, accept detected repository, confirm connection and board creation.
  await menu({ ...common, prompt: answers(["1", "1", "", "y", "y", "0"], output) });
  const [saved] = (await savedConnections()).connections;
  assert.equal(saved.repo, gh.repo);
  assert(output.some(s => s.includes(root) && s.includes(gh.repo)));
  assert(output.some(s => s.includes("approve project/MCP/hook permissions")));
  assert.equal(signIns, 1);
  assert.equal(checks, 1);
  const config = await read(path.join(root, ".codex/config.toml")), hooks = await read(path.join(root, ".codex/hooks.json"));
  await menu({ ...common, prompt: answers(["3", "1", "", "y", "0"]) });
  assert.equal(await read(path.join(root, ".codex/config.toml")), config);
  assert.equal(await read(path.join(root, ".codex/hooks.json")), hooks);
  assert.equal(gh.issues.length, 1);
});

test("guided setup cancellation and missing prerequisites make no GitHub writes", async t => {
  const x = await fixture(t), before = x.gh.calls, output = [];
  await menu({ cwd: x.root, github: x.gh, env: x.env, checkRequirements: async () => {}, signIn: async () => { throw new Error("Must not sign in after cancellation"); },
    prompt: answers(["3", "1", "", "n", "0"]), log: s => output.push(s) });
  assert.equal(x.gh.calls, before);
  await menu({ cwd: x.root, github: x.gh, checkRequirements: async () => { throw new Error("Install GitHub CLI (gh), then reopen your terminal."); }, prompt: answers(["3", "0"]), log: s => output.push(s) });
  assert(output.some(s => s.includes("Install GitHub CLI")));
  assert.equal(x.gh.calls, before);
});

test("readable status avoids live-presence claims, shows recovery state, and keeps counters/IDs in details", async () => {
  const result = [{ client: "codex", repo: "team/project", project: "/example", enabled: true, configured: true,
    apiUsage: { requests: 234, cooldownUntil: "2030-01-01T00:00:00Z" },
    chats: [{ id: "long-id", name: "Example\x1b[2J", latestUserMessage: "Build the form.", enabled: false, pendingRetirement: true, lastBoardCheck: null, pendingWrite: true }] }];
  const output = [];
  showStatus(result, { log: s => output.push(s) });
  assert(output.join("\n").includes("GitHub cleanup pending"));
  assert(output.join("\n").includes("Build the form."));
  assert(output.join("\n").includes("cooldown"));
  assert(!output.join("\n").includes("long-id"));
  assert(!output.join("\n").includes("234"));
  assert(!output.join("\n").includes("\x1b"));
  showStatus(result, { log: s => output.push(s), details: true });
  assert(output.join("\n").includes("long-id"));
});

test("scripted commands retain JSON output; explicit JSON and noninteractive menu behavior are predictable", async t => {
  const x = await fixture(t);
  const env = { ...process.env, ...x.env };
  const invoke = args => spawnSync(process.execPath, [ENTRY, ...args], { cwd: x.root, env, encoding: "utf8" });
  const piped = invoke(["status", "--client", "codex"]), explicit = invoke(["status", "--client", "codex", "--json"]);
  assert.equal(piped.status, 0, piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout), JSON.parse(explicit.stdout));
  assert(!piped.stdout.includes(x.chat.chat_key));
  assert.match(invoke([]).stdout, /guided menu/);
  assert.match(invoke(["menu"]).stderr, /requires a terminal/);
  assert.match(invoke(["disconnect", "--json"]).stderr, /only with status/);
});

test("menu offers a shared roster and opens only the selected board", async t => {
  const x = await fixture(t), opened = [], output = [], before = x.gh.comments.length;
  await menu({ cwd: x.root, env: x.env, github: x.gh, signIn: async () => {}, openBoard: async c => opened.push(c),
    prompt: answers(["1", "1", "2", "0", "2", "0"]), log: s => output.push(s) });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].repo, x.gh.repo);
  assert(output.some(s => s.includes("shared GitHub roster")));
  assert(output.some(s => s.includes(x.chat.id)), "IDs are available in details");
  assert(!output.join("\n").includes(x.chat.chat_key));
  assert.equal(x.gh.comments.length, before, "viewing/opening must not post anything");
});

test("linked connection records are skipped and replacement checkout links are never edited during cleanup", async t => {
  if (process.platform === "win32") return t.skip("Directory symlink privilege is not available in every Windows environment");
  const x = await fixture(t), other = await gitProject(t);
  const { file: otherFile } = await connect({ ...x.options, cwd: other, client: "codex" });
  await symlink(x.file, path.join(x.dir, "connections", "b".repeat(64) + ".json"));
  assert.equal((await savedConnections()).warnings.length, 1);
  const saved = (await savedConnections()).connections.find(c => c.root === x.root);
  const otherManifest = await read(otherFile), otherConfig = await read(path.join(other, ".codex/config.toml"));
  await rm(x.root, { recursive: true });
  await symlink(other, x.root, "dir");
  await disconnect({ saved, github: x.gh, log: () => {} });
  assert.equal(await read(otherFile), otherManifest);
  assert.equal(await read(path.join(other, ".codex/config.toml")), otherConfig);
  assert(!(await readJSON(x.file)).enabled);
});
