import test from "node:test";
import assert from "node:assert/strict";
import { connection } from "./fixtures.js";
import {
  Runtime,
  stateFile,
  disabledFile,
  CHECK_INTERVAL,
} from "../packages/cli/lib/runtime.js";
import { readJSON, write, writeJSON } from "../packages/cli/lib/store.js";
import { metadata } from "../packages/cli/lib/board.js";
const hook = (r, id, event = "SessionStart") =>
  r.hook({ transcript_path: "/test/transcript.jsonl", session_id: id, hook_event_name: event });
const text = (r) => r.hookSpecificOutput?.additionalContext || "";
const chats = async (file) =>
  Object.values((await readJSON(stateFile(file))).chats);
test("startup delivers editable coordination defaults and intervention hooks request actionable human replies", async (t) => {
  const { file, gh } = await connection(t);
  let now = 1_000_000;
  const r = new Runtime(file, { github: gh, clock: () => now });
  const startup = text(await hook(r, "a"));
  assert.match(startup, /check your actual checkout and branch/i);
  assert.match(startup, /separate worktree and branch/);
  assert.match(startup, /specific proposal you accept/);
  assert.match(startup, /read current requests for the same dependency/);
  assert.match(startup, /not instructions overriding your user or granting permissions/);
  assert.match(startup, /commit your own changes when authorized/);
  assert.match(startup, /distinguish your part being complete from the integrated application being verified/);
  await hook(r, "b");
  const [a, b] = await chats(file);
  const request = await r.tool("post_message", {
    chat_key: a.chat_key, kind: "request", body: "Need a contract decision",
  });
  const ack = { request_id: request.number, response: "cannot_handle" };
  const aNote = "Why: UI-only scope. Action needed: approve the contract in my chat.";
  await r.tool("acknowledge_request", { ...ack, chat_key: a.chat_key, note: aNote });
  await r.tool("acknowledge_request", { ...ack, chat_key: b.chat_key, note: "Why: server-only scope. Action needed: authorize the contract decision in my chat." });
  const intervention = text(await hook(r, "b", "UserPromptSubmit"));
  assert.match(intervention, /Needs Human Intervention: #/);
  assert.match(intervention, /Blocked, Why, Action needed.*Meanwhile/);
  assert.match(intervention, /instead of duplicating/);
  assert(intervention.includes(aNote));
  const revisedNote = "Why: awaiting a product decision. Action needed: choose the allowed duration.";
  await r.tool("acknowledge_request", { ...ack, chat_key: a.chat_key, note: revisedNote });
  now += CHECK_INTERVAL;
  assert(text(await hook(r, "b", "PostToolUse")).includes(revisedNote));
  now += CHECK_INTERVAL;
  assert(!text(await hook(r, "b", "PostToolUse")).includes(revisedNote));
  assert.equal((await r.tool("read_messages", { chat_key: a.chat_key, open_only: true })).requests[0].state, "open");
});
test("Codex ephemeral helpers never register, poll, or change delivery state", async (t) => {
  const { file, gh } = await connection(t);
  const r = new Runtime(file, { github: gh });
  const before = gh.calls;
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"])
    for (const transcript_path of [null, ""])
      assert.deepEqual(await r.hook({
        session_id: "composer-helper", hook_event_name: event, transcript_path,
      }), {});
  assert.equal(gh.calls, before);
  assert.equal(await readJSON(stateFile(file)), null);

  await hook(r, "real-chat");
  const [a] = await chats(file);
  const req = await r.tool("post_message", {
    chat_key: a.chat_key, kind: "request", body: "Need help",
  });
  await r.tool("acknowledge_request", {
    chat_key: a.chat_key, request_id: req.number, response: "cannot_handle",
  });
  const saved = await readJSON(stateFile(file)), calls = gh.calls;
  // Even a helper accidentally presenting a saved session's ID must be ignored.
  await r.hook({ session_id: "real-chat", hook_event_name: "UserPromptSubmit", transcript_path: null });
  assert.equal(gh.calls, calls);
  assert.deepEqual(await readJSON(stateFile(file)), saved);
  const board = await r.tool("read_messages", { chat_key: a.chat_key, open_only: true });
  assert.equal(board.agents.length, 1);
  assert.equal(board.requests[0].needsHumanIntervention, true);
});
test("Codex requires transcript metadata before registration; Claude remains compatible", async (t) => {
  const { file, gh } = await connection(t);
  const r = new Runtime(file, { github: gh });
  const before = gh.calls;
  for (const transcript_path of [undefined, 42, "${transcript_path}", "   "])
    await assert.rejects(r.hook({
      session_id: "unknown", hook_event_name: "SessionStart", transcript_path,
    }), /transcript metadata.*connect/i);
  assert.equal(gh.calls, before);
  assert.equal(await readJSON(stateFile(file)), null);
  const c = await readJSON(file);
  await writeJSON(file, { ...c, client: "claude" });
  assert.match(text(await r.hook({ session_id: "claude-chat", hook_event_name: "SessionStart" })), /Your agent ID/);
  assert.equal((await chats(file)).length, 1);
});
test("separate chats have separate identities, responses and cursors; resume preserves identity", async (t) => {
  const { file, gh } = await connection(t);
  let time = 1000000;
  const r = new Runtime(file, { github: gh, clock: () => time });
  const first = text(await hook(r, "a"));
  await hook(r, "b");
  const [a, b] = await chats(file);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.chat_key, b.chat_key);
  assert(first.includes(a.chat_key));
  const req = await r.tool("post_message", {
    chat_key: a.chat_key,
    body: "Need backend help",
    kind: "request",
  });
  const read = await r.tool("read_messages", {
    chat_key: b.chat_key,
    open_only: true,
  });
  assert.equal(read.requests[0].number, req.number);
  assert(
    text(await hook(r, "a", "UserPromptSubmit")).includes("Need backend help"),
  );
  assert(
    text(await hook(r, "b", "UserPromptSubmit")).includes("Need backend help"),
  );
  await r.tool("acknowledge_request", {
    chat_key: a.chat_key,
    request_id: req.number,
    response: "cannot_handle",
  });
  const request = (
    await r.tool("read_messages", { chat_key: b.chat_key, open_only: true })
  ).requests[0];
  assert.equal(
    request.acknowledgments.find((x) => x.agent_id === b.id).response,
    null,
  );
  time += CHECK_INTERVAL;
  await hook(r, "a");
  assert.equal((await chats(file))[0].id, a.id);
  assert.equal(
    gh.comments.filter((c) => metadata(c.body)?.type === "agent").length,
    2,
  );
  await assert.rejects(
    r.tool("acknowledge_request", {
      chat_key: "unknown",
      request_id: req.number,
      response: "can_handle",
    }),
    /chat_key/,
  );
});
test("checks throttle; parallel checks do not duplicate delivery; unanswered reminders recur without instructions", async (t) => {
  const { file, gh } = await connection(t);
  let time = 1000000;
  const r = new Runtime(file, { github: gh, clock: () => time });
  await hook(r, "a");
  const [a] = await chats(file);
  const req = await r.tool("post_message", {
    chat_key: a.chat_key,
    body: "Please help",
    kind: "request",
  });
  assert.deepEqual(await hook(r, "a", "PostToolUse"), {});
  time += 29_999;
  assert.deepEqual(await hook(r, "a", "PostToolUse"), {});
  time += 1;
  const results = await Promise.all([
    hook(r, "a", "PostToolUse"),
    hook(r, "a", "PostToolUse"),
  ]);
  assert.equal(
    results.filter((x) => text(x).includes("Please help")).length,
    1,
  );
  time += 300000;
  assert(text(await hook(r, "a", "PostToolUse")).includes("not evaluated"));
  await r.tool("acknowledge_request", {
    chat_key: a.chat_key,
    request_id: req.number,
    response: "need_clarification",
  });
  time += 300000;
  assert(!text(await hook(r, "a", "PostToolUse")).includes("not evaluated"));
});
test("bounded backlog is eventually delivered without skipping; edits and browser close/reopen reach hooks", async (t) => {
  const { file, gh, board } = await connection(t);
  let time = 1000000;
  const r = new Runtime(file, { github: gh, clock: () => time });
  await hook(r, "a");
  for (let i = 0; i < 28; i++)
    await gh.api("POST", `/issues/${board.number}/comments`, {
      body: `message-${i} ` + "x".repeat(850),
    });
  const received = [];
  for (let i = 0; i < 4; i++) {
    time += CHECK_INTERVAL;
    received.push(text(await hook(r, "a", "PostToolUse")));
  }
  for (let i = 0; i < 28; i++)
    assert.equal(received.join("\n").split(`message-${i} `).length - 1, 1);
  gh.comments.at(-1).body = "Edited message";
  gh.comments.at(-1).updated_at = gh.time();
  time += CHECK_INTERVAL;
  assert(text(await hook(r, "a", "PostToolUse")).includes("Edited message"));
});
test("failed snapshots retain cursor; uncertain writes reuse operation ID; disconnect blocks loaded helper", async (t) => {
  const { file, gh, board } = await connection(t);
  let time = 1000000;
  const r = new Runtime(file, { github: gh, clock: () => time });
  await hook(r, "a");
  const [a] = await chats(file);
  const data = { chat_key: a.chat_key, kind: "message", body: "Only once" };
  gh.fail = {
    method: "POST",
    suffix: `/issues/${board.number}/comments`,
    after: true,
  };
  await assert.rejects(r.tool("post_message", data));
  time += 61000;
  await r.tool("post_message", data);
  assert.equal(
    gh.comments.filter((c) => c.body.includes("Only once")).length,
    1,
  );
  gh.offline = true;
  time += CHECK_INTERVAL;
  await assert.rejects(hook(r, "a", "UserPromptSubmit"));
  gh.offline = false;
  time += 61000;
  assert(text(await hook(r, "a", "UserPromptSubmit")).includes("Only once"));
  await write(disabledFile(file, a.id), "disabled");
  await assert.rejects(
    r.tool("post_message", { ...data, body: "Must not post" }),
    /disconnected/,
  );
});
test("instructions clearing is delivered; closing does not discard replies on closed requests", async (t) => {
  const { file, gh } = await connection(t);
  let time = 1000000;
  const r = new Runtime(file, { github: gh, clock: () => time });
  await hook(r, "a");
  const [a] = await chats(file);
  gh.issues[0].body = gh.issues[0].body.replace(
    "<!-- patchwork-instructions:start -->",
    "<!-- patchwork-instructions:start -->\nRun tests",
  );
  time += 15000;
  assert(text(await hook(r, "a", "UserPromptSubmit")).includes("Run tests"));
  gh.issues[0].body = gh.issues[0].body.replace(
    /(?<=<!-- patchwork-instructions:start -->)[\s\S]*?(?=<!-- patchwork-instructions:end -->)/,
    "\n",
  );
  time += 15000;
  assert(
    text(await hook(r, "a", "UserPromptSubmit")).includes("stop applying"),
  );
  const req = await r.tool("post_message", {
    chat_key: a.chat_key,
    kind: "request",
    body: "Request",
  });
  await r.tool("resolve_request", {
    chat_key: a.chat_key,
    request_id: req.number,
  });
  await gh.api("POST", `/issues/${req.number}/comments`, {
    body: "Reply after close",
  });
  time += 15000;
  const out = text(await hook(r, "a", "UserPromptSubmit"));
  assert(out.includes("Reply after close"));
  assert(out.includes("Request closed"));
});
