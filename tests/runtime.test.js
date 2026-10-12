import test from "node:test";
import assert from "node:assert/strict";
import { connection } from "./fixtures.js";
import {
  Runtime,
  stateFile,
  disabledFile,
  CHECK_INTERVAL,
} from "../packages/cli/lib/runtime.js";
import { readJSON, write } from "../packages/cli/lib/store.js";
import { metadata } from "../packages/cli/lib/board.js";
const hook = (r, id, event = "SessionStart") =>
  r.hook({ session_id: id, hook_event_name: event });
const text = (r) => r.hookSpecificOutput?.additionalContext || "";
const chats = async (file) =>
  Object.values((await readJSON(stateFile(file))).chats);
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
  time += CHECK_INTERVAL;
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
  await r.tool("post_message", data);
  assert.equal(
    gh.comments.filter((c) => c.body.includes("Only once")).length,
    1,
  );
  gh.offline = true;
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
  assert(text(await hook(r, "a", "UserPromptSubmit")).includes("Run tests"));
  gh.issues[0].body = gh.issues[0].body.replace("\nRun tests", "");
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
  const out = text(await hook(r, "a", "UserPromptSubmit"));
  assert(out.includes("Reply after close"));
  assert(out.includes("Request closed"));
});
