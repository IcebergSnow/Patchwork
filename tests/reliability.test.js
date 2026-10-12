import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readdir, unlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  connection,
  temporary,
  gitProject,
  FakeGitHub,
  restClient,
} from "./fixtures.js";
import {
  Runtime,
  stateFile,
  REMINDER_INTERVAL,
} from "../packages/cli/lib/runtime.js";
import {
  readJSON,
  writeJSON,
  write,
  locked,
} from "../packages/cli/lib/store.js";
import {
  metadata,
  marked,
  visible,
  snapshot,
  register,
} from "../packages/cli/lib/board.js";
import {
  accountFile,
  boardFile,
  RECONCILE_INTERVAL,
} from "../packages/cli/lib/sync.js";
import { connect, disconnect, status } from "../packages/cli/lib/connect.js";

const hook = (r, session = "a", event = "UserPromptSubmit") =>
  r.hook({ transcript_path: "/test/transcript.jsonl", session_id: session, hook_event_name: event });
const text = (value) => value.hookSpecificOutput?.additionalContext || "";
const chats = async (file) =>
  Object.values((await readJSON(stateFile(file))).chats);
async function started(t) {
  const x = await connection(t);
  let now = 1_000_000;
  x.runtime = new Runtime(x.file, {
    github: restClient(x.gh, { pageSize: 7 }),
    clock: () => now,
  });
  x.advance = (ms = 60_000) => (now += ms);
  await hook(x.runtime);
  [x.chat] = await chats(x.file);
  x.request = async (body = "Blocked request") =>
    x.runtime.tool("post_message", {
      chat_key: x.chat.chat_key,
      kind: "request",
      body,
    });
  x.ack = (number, response, chat = x.chat) =>
    x.runtime.tool("acknowledge_request", {
      chat_key: chat.chat_key,
      request_id: number,
      response,
    });
  x.read = (input = {}) =>
    x.runtime.tool("read_messages", { chat_key: x.chat.chat_key, ...input });
  return x;
}

test("clarification and promised work stay visible; a new chat removes unanimity, not the unresolved blocker", async (t) => {
  const x = await started(t),
    request = await x.request();
  await x.ack(request.number, "need_clarification");
  await hook(x.runtime);
  x.advance(REMINDER_INTERVAL);
  let context = text(await hook(x.runtime, "a", "PostToolUse"));
  assert.match(context, /your response=need_clarification/);
  assert.match(context, /follow up/);
  assert.doesNotMatch(context, /not evaluated/);
  await x.ack(request.number, "can_handle");
  x.advance(REMINDER_INTERVAL);
  context = text(await hook(x.runtime));
  assert.match(context, /your response=can_handle/);
  assert.match(context, /acknowledgment is not completion/);
  assert.match(context, /explicitly expanded your scope/);
  await x.ack(request.number, "cannot_handle");
  assert.match(text(await hook(x.runtime)), /Needs Human Intervention: #/);
  await hook(x.runtime, "b");
  context = text(await hook(x.runtime));
  assert.match(context, /Still unresolved: #/);
  assert.match(context, /unanswered=1/);
  assert.equal(
    (await x.read({ open_only: true })).requests[0].needsHumanIntervention,
    false,
  );
  const [, b] = await chats(x.file);
  // Explicit retirement excludes the abandoned chat without treating silence as a decline.
  await register(x.gh, x.board.number, { ...b, ownerId: 1 }, false, "retire-b");
  x.advance();
  context = text(await hook(x.runtime));
  assert.match(context, /Needs Human Intervention: #/);
  assert.equal((await x.read({ open_only: true })).requests[0].state, "open");
});

test("request and history pagination survive closing/deleting earlier items and concurrent posts", async (t) => {
  const x = await started(t);
  for (let i = 0; i < 36; i++)
    await x.gh.api("POST", "/issues", {
      title: `Request ${i}`,
      body: "help",
      labels: ["patchwork"],
    });
  x.advance();
  const first = await x.read({ open_only: true });
  assert.equal(first.messages.length, 30);
  await x.gh.api("PATCH", `/issues/${first.messages[0].number}`, {
    state: "closed",
  });
  const later = await x.gh.api("POST", "/issues", {
    title: "Concurrent",
    body: "new",
    labels: ["patchwork"],
  });
  x.advance();
  const next = await x.read({ open_only: true, cursor: first.nextCursor });
  assert.deepEqual(
    next.messages.map((r) => r.number),
    [32, 33, 34, 35, 36, 37],
  );
  assert.equal(next.hasMore, false);
  await assert.rejects(x.read({ cursor: first.nextCursor }), /cursor/);
  await assert.rejects(
    x.read({
      open_only: true,
      cursor: Buffer.from(
        JSON.stringify({ board: 1, open: true, offset: 30 }),
      ).toString("base64url"),
    }),
    /Restart/,
  );
  await x.gh.api("PATCH", `/issues/${first.messages[0].number}`, {
    state: "open",
  });
  for (let i = 0; i < 40; i++)
    await x.gh.api("POST", "/issues/1/comments", { body: `history-${i}` });
  x.advance();
  const before = await x.read();
  // Removing an early request shrinks the history, but must not shift the next page.
  x.gh.issues = x.gh.issues.filter((i) => i.number !== 2);
  x.advance(RECONCILE_INTERVAL);
  let cursor = before.nextCursor,
    ids = before.messages.map((m) => m.id);
  while (cursor) {
    const page = await x.read({ cursor });
    ids.push(...page.messages.map((m) => m.id));
    cursor = page.nextCursor;
  }
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.includes(`issue:${later.number}`));
  for (const c of x.gh.comments) assert(ids.includes(`comment:${c.id}`));
});

test("metadata-only edits reach both cursors; verification is cached and foreign editors cannot impersonate acknowledgments", async (t) => {
  const x = await started(t);
  await hook(x.runtime, "b");
  const request = await x.request();
  await x.ack(request.number, "can_handle");
  await hook(x.runtime);
  await hook(x.runtime, "b");
  const ack = x.gh.comments.find((c) => metadata(c.body)?.type === "ack");
  const registration = x.gh.comments.find(
    (c) => metadata(c.body)?.type === "agent",
  );
  await x.gh.api("PATCH", `/issues/comments/${ack.id}`, {
    body: marked(visible(ack.body), {
      ...metadata(ack.body),
      response: "need_clarification",
    }),
  });
  await x.gh.api("PATCH", `/issues/comments/${registration.id}`, {
    body: marked(visible(registration.body), {
      ...metadata(registration.body),
      name: "Renamed",
    }),
  });
  x.advance();
  for (const session of ["a", "b"]) {
    const out = text(await hook(x.runtime, session));
    assert.match(out, /"response":"need_clarification"/);
    assert.match(out, /Renamed/);
  }
  const count = x.gh.history.filter((h) => h.suffix === "/graphql").length;
  x.advance();
  await hook(x.runtime);
  assert.equal(
    x.gh.history.filter((h) => h.suffix === "/graphql").length,
    count,
  );
  const author = x.gh.user;
  x.gh.user = { id: 2, login: "editor" };
  await x.gh.api("PATCH", `/issues/comments/${ack.id}`, {
    body: marked(visible(ack.body), {
      ...metadata(ack.body),
      response: "cannot_handle",
    }),
  });
  x.gh.user = author;
  // Edits can share the creation second; author equality still must be checked.
  ack.updated_at = ack.created_at;
  x.advance();
  assert.match(text(await hook(x.runtime)), /Ignored unverifiable/);
  const current = (await x.read({ open_only: true })).requests[0];
  assert.equal(current.acknowledgments[0].response, null);
  assert.equal(current.needsHumanIntervention, false);
  // A legitimate new response must not be deduplicated against the forged edit.
  await x.ack(request.number, "cannot_handle");
  assert.equal(
    x.gh.comments.filter((c) => metadata(c.body)?.type === "ack").length,
    2,
  );
});

test("malformed metadata and edited registrations fail closed with visible warnings", async (t) => {
  const x = await started(t),
    request = await x.request();
  await x.ack(request.number, "cannot_handle");
  const reg = x.gh.comments.find((c) => metadata(c.body)?.type === "agent");
  x.gh.user = { id: 2, login: "editor" };
  await x.gh.api("PATCH", `/issues/comments/${reg.id}`, {
    body: marked(visible(reg.body), { ...metadata(reg.body), active: false }),
  });
  x.gh.user = { id: 1, login: "alice" };
  await x.gh.api("POST", "/issues/1/comments", {
    body: marked("Malformed", ["not an object"]),
  });
  const s = await snapshot(restClient(x.gh), 1);
  assert.equal(s.agents.length, 0);
  assert.equal(s.requests[0].needsHumanIntervention, false);
  assert.equal(s.warnings.length, 2);
  assert.equal(metadata(marked("bad", "x")), null);
  assert.equal(metadata(marked("bad", { name: "x".repeat(9000) })), null);
});

test("verification failure and deletions preserve or update delivery correctly", async (t) => {
  const x = await started(t);
  const post = await x.gh.api("POST", "/issues/1/comments", { body: "before" });
  x.advance();
  await hook(x.runtime);
  const previous = (await chats(x.file))[0].seen;
  await x.gh.api("PATCH", `/issues/comments/${post.id}`, { body: "after" });
  x.advance();
  const broken = restClient(x.gh, {
    intercept: ({ endpoint }) => {
      if (endpoint === "/graphql") throw { status: 503 };
    },
  });
  const failing = new Runtime(x.file, {
    github: broken,
    clock: x.runtime.clock,
  });
  await assert.rejects(hook(failing));
  assert.deepEqual((await chats(x.file))[0].seen, previous);
  x.advance(61_000);
  assert.match(text(await hook(x.runtime)), /after/);
  await x.gh.api("DELETE", `/issues/comments/${post.id}`);
  x.advance(RECONCILE_INTERVAL);
  assert.match(
    text(await hook(x.runtime)),
    new RegExp(`Removed from the board.*comment:${post.id}`),
  );
  assert.equal((await chats(x.file))[0].seen[`comment:${post.id}`], undefined);
});

test("uncertain request/acknowledgment retries reuse operation IDs, including missing labels", async (t) => {
  const x = await started(t);
  x.gh.fail = { method: "POST", suffix: "/issues", after: true };
  await assert.rejects(x.request("Only once"));
  x.gh.issues.at(-1).labels = []; // Created successfully, but requested label was not applied.
  x.advance(61_000);
  const request = await x.request("Only once");
  assert.equal(x.gh.issues.length, 2);
  assert(x.gh.issues[1].labels.some((l) => l.name === "patchwork"));
  x.gh.fail = {
    method: "POST",
    suffix: `/issues/${request.number}/comments`,
    after: true,
  };
  await assert.rejects(x.ack(request.number, "can_handle"));
  x.advance(61_000);
  const restarted = new Runtime(x.file, {
    github: restClient(x.gh),
    clock: x.runtime.clock,
  });
  await restarted.tool("acknowledge_request", {
    chat_key: x.chat.chat_key,
    request_id: request.number,
    response: "can_handle",
  });
  assert.equal(
    x.gh.comments.filter((c) => metadata(c.body)?.type === "ack").length,
    1,
  );
  assert.equal((await chats(x.file))[0].pending, null);
});

test("failed cache commit keeps a successful write retryable after process restart", async (t) => {
  const x = await started(t),
    c = await readJSON(x.file),
    cache = boardFile(c);
  const original = x.gh.perform.bind(x.gh);
  x.gh.perform = async (method, suffix, data) => {
    const result = await original(method, suffix, data);
    if (method === "POST" && suffix === "/issues/1/comments") {
      await unlink(cache);
      await mkdir(cache); // Fail the atomic cache save after GitHub accepted the post.
    }
    return result;
  };
  const data = {
    chat_key: x.chat.chat_key,
    kind: "message",
    body: "Recover committed post",
  };
  await assert.rejects(x.runtime.tool("post_message", data));
  assert((await chats(x.file))[0].pending);
  x.gh.perform = original;
  await rm(cache, { recursive: true });
  const restarted = new Runtime(x.file, {
    github: restClient(x.gh),
    clock: x.runtime.clock,
  });
  await restarted.tool("post_message", data);
  assert.equal(
    x.gh.comments.filter((c) => c.body.includes(data.body)).length,
    1,
  );
});

test("offline individual retirement/reconnect preserves the cursor; lost state has owner/maintainer recovery", async (t) => {
  const root = await gitProject(t),
    dir = await temporary(t),
    gh = new FakeGitHub();
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const options = {
    cwd: root,
    client: "codex",
    repo: gh.repo,
    github: gh,
    create: true,
    log: () => {},
  };
  const { file } = await connect(options);
  let now = Date.now();
  const runtime = new Runtime(file, { github: gh, clock: () => now });
  await hook(runtime);
  const [a] = await chats(file),
    seen = a.seen;
  gh.offline = true;
  await disconnect({ cwd: root, agent: a.id, github: gh, log: () => {} });
  assert.equal(
    (await status({ cwd: root }))[0].chats[0].pendingRetirement,
    true,
  );
  gh.offline = false;
  await gh.api("POST", "/issues/1/comments", {
    body: "Posted while disconnected",
  });
  now += 61_000;
  await connect({ ...options, agent: a.id });
  assert.deepEqual((await chats(file))[0].seen, seen);
  assert.match(text(await hook(runtime)), /Posted while disconnected/);
  assert.equal((await chats(file))[0].id, a.id);
  // Whole-project reconnect also resumes the same chat after offline disconnect.
  gh.offline = true;
  await disconnect({ cwd: root, github: gh, log: () => {} });
  gh.offline = false;
  now += 61_000;
  await connect(options);
  await hook(runtime);
  assert.equal(
    (await snapshot(gh, 1)).agents.find((r) => r.agent_id === a.id).active,
    true,
  );
  // Delete local state: recovery commands must not need a worktree or session key.
  await unlink(stateFile(file));
  assert(
    (await status({ repo: gh.repo, github: gh })).agents.some(
      (r) => r.agent_id === a.id,
    ),
  );
  gh.user = { id: 2, login: "teammate" };
  await assert.rejects(
    disconnect({ repo: gh.repo, agent: a.id, github: gh, log: () => {} }),
    /owner or a repository maintainer/,
  );
  gh.managers.add("teammate");
  const account = await readJSON(accountFile({ ownerId: 2 }));
  account.permissions[99]["2:teammate"] = {
    at: Date.now(),
    allowed: true,
    manager: false,
  };
  await writeJSON(accountFile({ ownerId: 2 }), account);
  // Explicit remote recovery should use fresh manager verification, including projection.
  await disconnect({ repo: gh.repo, agent: a.id, github: gh, log: () => {} });
  assert.equal((await snapshot(gh, 1)).agents[0].active, false);
  const count = gh.comments.length;
  await disconnect({ repo: gh.repo, agent: a.id, github: gh, log: () => {} });
  assert.equal(gh.comments.length, count);
});

test("concurrent chats share a slow API poll without lock failures or duplicate fetches", async (t) => {
  const x = await started(t),
    c = await readJSON(x.file);
  const second = `${x.file}.second.json`;
  await writeJSON(second, { ...c, client: "claude" });
  const other = new Runtime(second, {
    github: restClient(x.gh),
    clock: x.runtime.clock,
  });
  await hook(other, "b");
  await x.gh.api("POST", "/issues/1/comments", {
    body: "Slow concurrent update",
  });
  x.advance();
  let notify;
  const ready = new Promise((resolve) => (notify = resolve));
  let delayed = false;
  const slow = new Runtime(x.file, {
    clock: x.runtime.clock,
    github: restClient(x.gh, {
      intercept: async ({ endpoint }) => {
        if (!delayed && endpoint === `/repos/${x.gh.repo}/issues/1`) {
          delayed = true;
          notify();
          await new Promise((resolve) => setTimeout(resolve, 10_500));
        }
      },
    }),
  });
  const before = (await readJSON(accountFile(c))).stats.requests;
  const first = hook(slow);
  await ready;
  const results = await Promise.all([first, hook(other, "b")]);
  for (const result of results)
    assert.match(text(result), /Slow concurrent update/);
  assert.equal((await readJSON(accountFile(c))).stats.requests - before, 3);
  assert.doesNotMatch(text(await hook(other, "b")), /Slow concurrent update/);
});

test("locks reject recursive acquisition and recover crashed owners without overlapping writers", async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, "state");
  await locked(file, async () =>
    assert.rejects(
      locked(file, async () => {}),
      /Recursive/,
    ),
  );
  const module = new URL("../packages/cli/lib/store.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { locked } from ${JSON.stringify(module)}; await locked(process.argv[1], async () => { console.log('ready'); process.exit(0); });`,
      file,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  await once(child.stdout, "data");
  await exit;
  assert.equal((await readdir(`${file}.lock`)).length, 1);
  let inside = 0,
    total = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      locked(file, async () => {
        assert.equal(inside++, 0);
        await new Promise((r) => setTimeout(r, 3));
        total++;
        inside--;
      }),
    ),
  );
  assert.equal(total, 12);
  // An empty directory is an interrupted release; the old PID-file format also recovers.
  await mkdir(`${file}.lock`);
  await locked(file, async () => {});
  await write(`${file}.lock`, String(child.pid));
  await locked(file, async () => {});
});

test("Windows stale-lock sharing violations retry acquisition without losing mutual exclusion", async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, "state"),
    lock = `${file}.lock`;
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  const owner = path.join(lock, `${child.pid}-${crypto.randomUUID()}`);
  await mkdir(lock);
  await write(owner, "");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const originals = { readdir: fs.readdir, unlink: fs.unlink, rmdir: fs.rmdir };
  const failures = new Set();
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    for (const [name, code] of [
      ["readdir", "EPERM"],
      ["unlink", "EACCES"],
      ["rmdir", "EBUSY"],
    ]) {
      fs[name] = async (...args) => {
        if (args[0] === (name === "unlink" ? owner : lock) && !failures.has(name)) {
          failures.add(name);
          throw Object.assign(new Error("Transient sharing violation"), { code });
        }
        return originals[name](...args);
      };
    }
    syncBuiltinESMExports();
    let inside = 0,
      completed = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        locked(file, async () => {
          assert.equal(inside++, 0);
          await new Promise((resolve) => setTimeout(resolve, 3));
          completed++;
          inside--;
        }),
      ),
    );
    assert.equal(completed, 4);
    assert.equal(failures.size, 3);
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
  await assert.rejects(readdir(lock), { code: "ENOENT" });
});
