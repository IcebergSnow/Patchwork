import test from "node:test";
import assert from "node:assert/strict";
import { readJSON, write } from "../packages/cli/lib/store.js";
import {
  withBoard,
  boardFile,
  accountFile,
  RECONCILE_INTERVAL,
  OVERLAP,
} from "../packages/cli/lib/sync.js";
import { register, marked, metadata } from "../packages/cli/lib/board.js";
import { connection, restClient } from "./fixtures.js";
import { Runtime, stateFile } from "../packages/cli/lib/runtime.js";
const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alice",
  client: "codex",
  ownerId: 1,
};
async function setup(t, options) {
  const { file, gh: remote, board } = await connection(t);
  await register(remote, board.number, agent, true, "register");
  const c = await readJSON(file);
  let now = 1700000000000;
  const gh = restClient(remote, options),
    clock = () => now;
  return {
    file,
    c,
    gh,
    remote,
    clock,
    advance: (n) => {
      now += n;
    },
    poll: (age = 0) =>
      withBoard(
        c,
        gh,
        async (s) => {
          await s.poll(age);
          return s.view();
        },
        clock,
      ),
    issue: async (body = "Request") =>
      remote.api("POST", "/issues", {
        title: body,
        body,
        labels: ["patchwork"],
      }),
  };
}

test("idle sync is constant-size, shared across clients, durable across restarts and conditional", async (t) => {
  const x = await setup(t);
  for (let i = 0; i < 20; i++) {
    const r = await x.issue();
    if (i < 15)
      await x.remote.api("PATCH", `/issues/${r.number}`, { state: "closed" });
  }
  await x.poll();
  const before = (await readJSON(accountFile(x.c))).stats;
  x.advance(60000);
  await x.poll();
  const after = (await readJSON(accountFile(x.c))).stats;
  assert.equal(after.requests - before.requests, 3);
  assert(after.notModified > before.notModified);
  const g2 = restClient(x.remote);
  x.advance(60000); // Both clients arrive when the shared cache is stale.
  await Promise.all([
    x.poll(15000),
    withBoard(
      x.c,
      g2,
      async (s) => {
        await s.poll(15000);
        return s.view();
      },
      x.clock,
    ),
  ]);
  assert.equal(
    (await readJSON(accountFile(x.c))).stats.requests,
    after.requests + 3,
  );
  await x.poll(15000);
  assert.equal(
    (await readJSON(accountFile(x.c))).stats.requests,
    after.requests + 3,
  );
  assert.equal(
    Object.keys((await readJSON(boardFile(x.c))).records.requests).length,
    20,
  );
});

test("incremental edits on closed requests, acknowledgments, instructions and registrations are observed", async (t) => {
  const x = await setup(t),
    issue = await x.issue();
  const ack = await x.remote.api("POST", `/issues/${issue.number}/comments`, {
    body: marked("Can handle", {
      type: "ack",
      agent_id: agent.id,
      response: "can_handle",
    }),
  });
  await x.remote.api("PATCH", `/issues/${issue.number}`, { state: "closed" });
  await x.poll();
  // Advance the server clock beyond the overlap: old comments must be found by UPDATED time.
  x.remote.counter += OVERLAP / 1000 + 10;
  await x.poll();
  await x.remote.api("PATCH", `/issues/comments/${ack.id}`, {
    body: marked("Cannot handle", {
      type: "ack",
      agent_id: agent.id,
      response: "cannot_handle",
    }),
  });
  await x.remote.api("POST", `/issues/${issue.number}/comments`, {
    body: "After closing",
  });
  await x.remote.api("PATCH", `/issues/${issue.number}`, { state: "open" });
  await x.remote.api("PATCH", `/issues/${issue.number}`, { state: "closed" });
  await x.remote.api("PATCH", `/issues/1`, {
    body: x.remote.issues[0].body.replace(
      /(?<=<!-- patchwork-instructions:start -->)[\s\S]*?(?=<!-- patchwork-instructions:end -->)/,
      "\nRun tests\n",
    ),
  });
  x.advance(60000);
  let s = await x.poll();
  assert.equal(s.requests[0].acknowledgments[0].response, "cannot_handle");
  assert(s.events.some((e) => e.body === "After closing"));
  assert.equal(s.events.filter((e) => e.kind === "status").length, 3);
  assert.equal(s.instructions, "Run tests");
  const registration = x.remote.comments.find(
    (c) => metadata(c.body)?.type === "agent",
  );
  await x.remote.api("PATCH", `/issues/comments/${registration.id}`, {
    body: marked("Retired", { ...metadata(registration.body), active: false }),
  });
  s = await x.poll();
  assert.equal(s.agents[0].active, false);
});

test("full reconciliation catches old missed records and deletions; damaged cache rebuilds", async (t) => {
  const x = await setup(t),
    request = await x.issue();
  await x.poll();
  x.remote.counter += 600;
  await x.poll();
  const lost = await x.remote.api("POST", "/issues/1/comments", {
    body: "Late visibility",
  });
  const actual = x.remote.comments.find((c) => c.id === lost.id);
  actual.updated_at = "2020-01-01T00:00:00.000Z";
  assert(!(await x.poll()).events.some((e) => e.body === "Late visibility"));
  x.advance(RECONCILE_INTERVAL);
  assert((await x.poll()).events.some((e) => e.body === "Late visibility"));
  await x.remote.api("DELETE", `/issues/comments/${lost.id}`);
  x.remote.issues = x.remote.issues.filter((i) => i.number !== request.number);
  x.advance(RECONCILE_INTERVAL);
  const state = await x.poll();
  assert(!state.events.some((e) => e.id === `comment:${lost.id}`));
  assert.equal(state.requests.length, 0);
  await write(boardFile(x.c), "{broken");
  assert.equal((await x.poll()).agents.length, 1);
});

test("a failed page never advances the watermark; offline recovery and overlapping pages deduplicate", async (t) => {
  let failPage = false;
  const x = await setup(t, {
    pageSize: 2,
    intercept: ({ endpoint }) => {
      if (
        failPage &&
        endpoint.includes("/issues/comments?") &&
        endpoint.includes("page=2")
      )
        throw { status: 503 };
    },
  });
  await x.poll();
  const before = await readJSON(boardFile(x.c));
  for (let i = 0; i < 7; i++)
    await x.remote.api("POST", "/issues/1/comments", { body: `paged-${i}` });
  failPage = true;
  x.advance(60000);
  await assert.rejects(x.poll());
  assert.equal((await readJSON(boardFile(x.c))).since, before.since);
  assert.deepEqual((await readJSON(boardFile(x.c))).records, before.records);
  const count = (await readJSON(accountFile(x.c))).stats.requests;
  await assert.rejects(x.poll()); // Shared cooldown prevents another HTTP request.
  assert.equal((await readJSON(accountFile(x.c))).stats.requests, count);
  failPage = false;
  x.advance(61000);
  const state = await x.poll();
  for (let i = 0; i < 7; i++)
    assert.equal(state.events.filter((e) => e.body === `paged-${i}`).length, 1);
  assert.equal((await x.poll()).events.length, state.events.length);
});

test("repository and credential changes cannot reuse verification; fresh permissions gate writes", async (t) => {
  const x = await setup(t);
  await x.poll();
  const before = (await readJSON(accountFile(x.c))).stats.requests;
  x.remote.user = { id: 2, login: "bob" };
  await assert.rejects(x.poll(15000), /account changed/);
  assert.equal((await readJSON(accountFile(x.c))).stats.requests, before + 1);
  x.remote.user = { id: 1, login: "alice" };
  await x.poll();
  x.remote.noWrite = true;
  await assert.rejects(
    withBoard(x.c, x.gh, (s) => s.authorize(), x.clock),
    /write access/,
  );
  await assert.rejects(x.poll(), /write access/);
  x.remote.noWrite = false;
  await x.poll();
  x.remote.repoId = 100;
  await assert.rejects(
    withBoard(x.c, x.gh, (s) => s.authorize(), x.clock),
    /identity changed/,
  );
  const raw = JSON.stringify(await readJSON(accountFile(x.c)));
  assert(!raw.includes("private-test-token"));
});

test("collaborator verification expires, and a changed token rechecks even before TTL", async (t) => {
  const x = await setup(t);
  assert.equal((await x.poll()).agents.length, 1);
  x.remote.blockedUsers.add("alice");
  assert.equal((await x.poll()).agents.length, 1); // Bounded five-minute roster cache.
  x.advance(300000);
  assert.equal((await x.poll()).agents.length, 0);
  x.remote.blockedUsers.clear();
  x.remote.tokenVersion = 1;
  assert.equal((await x.poll()).agents.length, 1);
});

test("a removed collaborator does not force repeated account and roster checks", async (t) => {
  const x = await setup(t, {
    intercept: ({ endpoint }) => {
      if (endpoint.includes("/collaborators/")) throw { status: 404 };
    },
  });
  assert.equal((await x.poll()).agents.length, 0);
  const before = (await readJSON(accountFile(x.c))).stats.requests;
  x.advance(60000);
  assert.equal((await x.poll()).agents.length, 0);
  assert.equal((await readJSON(accountFile(x.c))).stats.requests - before, 3);
});

test("rate limits and transient backoff are shared across chats and manual tools; retry deadlines win", async (t) => {
  let failing = false;
  const x = await setup(t, {
    intercept: ({ endpoint }) => {
      if (failing && endpoint.endsWith("/issues/1"))
        throw {
          status: 429,
          headers: "HTTP/2.0 429 Too Many Requests\nRetry-After: 300\n\n",
        };
    },
  });
  await x.poll();
  failing = true;
  x.advance(60000);
  await assert.rejects(x.poll());
  const account = await readJSON(accountFile(x.c));
  const other = new Runtime(x.file, {
    github: restClient(x.remote),
    clock: x.clock,
  });
  await assert.rejects(
    other.hook({ transcript_path: "/test/transcript.jsonl", session_id: "new", hook_event_name: "SessionStart" }),
  );
  assert.equal(
    (await readJSON(accountFile(x.c))).stats.requests,
    account.stats.requests,
  );
  await assert.rejects(
    withBoard(x.c, restClient(x.remote), (s) => s.authorize(), x.clock),
  );
  assert.equal(
    (await readJSON(accountFile(x.c))).stats.requests,
    account.stats.requests,
  );
  assert(account.retryAt >= Date.now() + 290000);
});

test("independent chat cursors recover after shared cache progress and failed delivery", async (t) => {
  const x = await setup(t),
    r = new Runtime(x.file, { github: x.gh, clock: x.clock });
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "a", hook_event_name: "SessionStart" });
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "b", hook_event_name: "SessionStart" });
  await x.remote.api("POST", "/issues/1/comments", {
    body: "Everyone sees this",
  });
  x.advance(60000);
  const a = await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "a", hook_event_name: "PostToolUse" });
  const before = (await readJSON(accountFile(x.c))).stats.requests;
  const restarted = new Runtime(x.file, {
    github: restClient(x.remote),
    clock: x.clock,
  });
  const b = await restarted.hook({
    transcript_path: "/test/transcript.jsonl",
    session_id: "b",
    hook_event_name: "PostToolUse",
  });
  assert(a.hookSpecificOutput.additionalContext.includes("Everyone sees this"));
  assert(b.hookSpecificOutput.additionalContext.includes("Everyone sees this"));
  assert.equal((await readJSON(accountFile(x.c))).stats.requests, before);
  const state = await readJSON(stateFile(x.file));
  assert.equal(Object.keys(state.chats).length, 2);
  assert.notEqual(...Object.values(state.chats).map((c) => c.chat_key));
});

test("server time bounds incremental cursors despite local clock skew; label removals and additions reconcile", async (t) => {
  const x = await setup(t),
    issue = await x.issue();
  x.advance(10 * 365 * 86400000);
  await x.poll();
  assert((await readJSON(boardFile(x.c))).since < x.clock() - 365 * 86400000);
  await x.remote.api("POST", `/issues/${issue.number}/comments`, {
    body: "Not skipped by a fast local clock",
  });
  assert(
    (await x.poll()).events.some(
      (e) => e.body === "Not skipped by a fast local clock",
    ),
  );
  await x.remote.api("DELETE", `/issues/${issue.number}/labels/patchwork`);
  assert.equal((await x.poll()).requests.length, 0);
  await x.remote.api("POST", `/issues/${issue.number}/labels`, {
    labels: ["patchwork"],
  });
  const state = await x.poll();
  assert.equal(state.requests.length, 1);
  assert.equal(
    state.events.filter((e) => e.body === "Not skipped by a fast local clock")
      .length,
    1,
  );
});

test("successful writes update the shared cache without rescanning historical threads", async (t) => {
  const x = await setup(t),
    r = new Runtime(x.file, { github: x.gh, clock: x.clock });
  for (let i = 0; i < 10; i++) await x.issue();
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "a", hook_event_name: "SessionStart" });
  const chat = Object.values((await readJSON(stateFile(x.file))).chats)[0];
  x.remote.history = [];
  await r.tool("post_message", {
    chat_key: chat.chat_key,
    body: "Saved locally from GitHub's response",
  });
  assert(
    !x.remote.history.some((h) => /^\/issues\/\d+\/events/.test(h.suffix)),
  );
  const before = (await readJSON(accountFile(x.c))).stats.requests;
  const read = await r.tool("read_messages", { chat_key: chat.chat_key });
  assert(read.messages.some((e) => e.body.includes("Saved locally")));
  assert.equal((await readJSON(accountFile(x.c))).stats.requests, before);
  x.remote.noWrite = true;
  await assert.rejects(
    r.tool("post_message", {
      chat_key: chat.chat_key,
      body: "Must never be posted",
    }),
    /write access/,
  );
  assert(
    !x.remote.comments.some((c) => c.body.includes("Must never be posted")),
  );
});

test("a remotely retired chat cannot refresh intervention labels", async (t) => {
  const x = await setup(t),
    request = await x.issue(),
    runtime = new Runtime(x.file, { github: x.gh, clock: x.clock });
  await x.remote.api("POST", `/issues/${request.number}/comments`, {
    body: marked("Cannot handle", {
      type: "ack",
      agent_id: agent.id,
      response: "cannot_handle",
    }),
  });
  await runtime.hook({ transcript_path: "/test/transcript.jsonl", session_id: "a", hook_event_name: "SessionStart" });
  const chat = Object.values((await readJSON(stateFile(x.file))).chats)[0];
  await register(x.remote, x.c.board, chat, false, "retire");
  x.remote.history = [];
  x.advance(60000);
  await assert.rejects(
    runtime.hook({ transcript_path: "/test/transcript.jsonl", session_id: "a", hook_event_name: "UserPromptSubmit" }),
    /retired/,
  );
  assert(x.remote.history.every((call) => call.method === "GET"));
});

test("HTTP authentication errors clear caches and repeated failures increase shared backoff", async (t) => {
  let failing = false;
  const x = await setup(t, {
    intercept: ({ endpoint }) => {
      if (failing && endpoint.endsWith("/issues/1")) throw { status: 401 };
    },
  });
  await x.poll();
  failing = true;
  await assert.rejects(x.poll());
  let state = await readJSON(accountFile(x.c));
  assert.deepEqual(state.auth, {});
  assert.deepEqual(state.permissions, {});
  assert.equal(state.retryAt - x.clock(), 60000);
  x.advance(61000);
  await assert.rejects(x.poll());
  state = await readJSON(accountFile(x.c));
  assert.equal(state.retryAt - x.clock(), 120000);
  failing = false;
  x.advance(121000);
  await x.poll();
  assert.equal((await readJSON(accountFile(x.c))).retryAt, 0);
});
