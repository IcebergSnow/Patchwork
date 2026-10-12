import test from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, connection } from "./fixtures.js";
import {
  createBoard,
  findBoard,
  snapshot,
  marked,
  metadata,
  register,
  perform,
  reconcileIntervention,
  INTERVENTION_LABEL,
  instructions,
  boardBody,
} from "../packages/cli/lib/board.js";
import { GitHub, repository } from "../packages/cli/lib/github.js";
const agent = (n, ownerId = 1) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name: "Agent " + n,
  client: "codex",
  ownerId,
});
test("first setup creates board and labels; later setup reuses it", async () => {
  const gh = new FakeGitHub();
  const a = await createBoard(gh),
    b = await createBoard(gh);
  assert.equal(a.number, b.number);
  assert.equal(gh.issues.length, 1);
  assert.equal(gh.labels.length, 3);
  assert.equal((await findBoard(gh)).number, 1);
});
test("all explicit declines flag intervention; silence and clarification do not; replies never resolve", async () => {
  const gh = new FakeGitHub(),
    board = await createBoard(gh),
    a = agent(1),
    b = agent(2),
    c = { board: board.number, ownerId: 1 };
  await register(gh, c.board, a, true, "join-a");
  await register(gh, c.board, b, true, "join-b");
  const r = await perform(
    gh,
    c,
    a,
    { action: "post", kind: "request", body: "Need staging access" },
    "request",
    async () => {},
  );
  await perform(
    gh,
    c,
    a,
    { action: "ack", request_id: r.number, response: "cannot_handle" },
    "a1",
    async () => {},
  );
  let s = await snapshot(gh, c.board);
  assert.equal(s.requests[0].needsHumanIntervention, false);
  assert.equal(s.requests[0].acknowledgments[1].response, null);
  await perform(
    gh,
    c,
    b,
    { action: "ack", request_id: r.number, response: "need_clarification" },
    "b1",
    async () => {},
  );
  assert.equal(
    (await snapshot(gh, c.board)).requests[0].needsHumanIntervention,
    false,
  );
  await perform(
    gh,
    c,
    b,
    { action: "ack", request_id: r.number, response: "cannot_handle" },
    "b2",
    async () => {},
  );
  s = await snapshot(gh, c.board);
  assert.equal(s.requests[0].needsHumanIntervention, true);
  await reconcileIntervention(gh, s);
  assert(gh.issues[1].labels.some((l) => l.name === INTERVENTION_LABEL));
  await perform(
    gh,
    c,
    a,
    {
      action: "post",
      kind: "message",
      replyTo: `issue:${r.number}`,
      body: "Discussing this",
    },
    "reply",
    async () => {},
  );
  assert.equal(gh.issues[1].state, "open");
  const count = gh.comments.length;
  await perform(
    gh,
    c,
    b,
    { action: "ack", request_id: r.number, response: "cannot_handle" },
    "b3",
    async () => {},
  );
  assert.equal(gh.comments.length, count);
  await perform(
    gh,
    c,
    a,
    { action: "resolve", request_id: r.number },
    "close",
    async () => {},
  );
  s = await snapshot(gh, c.board);
  assert.equal(s.requests[0].needsHumanIntervention, false);
  assert.equal(s.events.filter((e) => e.kind === "status").length, 1);
  await perform(
    gh,
    c,
    a,
    { action: "resolve", request_id: r.number, reopen: true },
    "open",
    async () => {},
  );
  assert.equal(
    (await snapshot(gh, c.board)).requests[0].needsHumanIntervention,
    true,
  );
});
test("metadata cannot impersonate another GitHub owner; outsiders cannot register; retirement retains history", async () => {
  const gh = new FakeGitHub(),
    board = await createBoard(gh),
    a = agent(1);
  await register(gh, board.number, a, true, "j");
  gh.user = { id: 2, login: "mallory" };
  await register(gh, board.number, a, false, "fake");
  gh.blockedUsers.add("mallory");
  await register(gh, board.number, agent(2, 2), true, "outsider");
  let s = await snapshot(gh, board.number);
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].active, true);
  gh.user = { id: 1, login: "alice" };
  await register(gh, board.number, a, false, "retire");
  s = await snapshot(gh, board.number);
  assert.equal(s.agents[0].active, false);
});
test("only marked Patchwork requests can be changed and metadata is bounded to the final marker", async () => {
  const gh = new FakeGitHub(),
    board = await createBoard(gh);
  await assert.rejects(
    perform(
      gh,
      { board: board.number, ownerId: 1 },
      agent(1),
      { action: "resolve", request_id: board.number },
      "x",
      async () => {},
    ),
    /not a Patchwork/,
  );
  assert.equal(metadata(marked("Hello", { type: "message" })).type, "message");
  assert.equal(metadata("hello <!-- patchwork:v1:notjson -->"), null);
  assert.equal(instructions(boardBody(gh.repo)), "");
});
test("GitHub transport uses fixed host/argv, JSON stdin, full pagination, sanitized errors", async () => {
  const calls = [];
  const gh = new GitHub("team/project", async (...args) => {
    calls.push(args);
    if (args[1].includes("POST")) return "{}";
    return args[1].some((x) => x.includes("page=2"))
      ? 'HTTP/2.0 200 OK\nETag: two\n\n[{\"id\":2}]'
      : 'HTTP/2.0 200 OK\nETag: one\nLink: <https://api.github.com/repos/team/project/issues?state=all&page=2>; rel=\"next\"\n\n[{\"id\":1}]';
  });
  assert.deepEqual(await gh.list("/issues?state=all"), [{ id: 1 }, { id: 2 }]);
  assert(calls[0][1].includes("--include"));
  assert(calls[1][1].some((x) => x.includes("page=2")));
  await gh.api("POST", "/issues", { body: "$(secret) `token`" });
  assert.equal(calls[2][2].input, '{"body":"$(secret) `token`"}');
  await assert.rejects(gh.request("GET", "https://evil.example"), /outside/);
  assert.throws(() => repository("team/repo/../../evil"));
  const bad = new GitHub("team/project", async () => {
    throw { details: "HTTP 403 super-secret-token" };
  });
  await assert.rejects(
    bad.api("GET"),
    (e) => e.status === 403 && !e.message.includes("secret"),
  );
});

test("conditional pagination reuses 304 bodies, follows changed links, and rejects foreign links", async () => {
  let count = 0;
  const calls = [];
  const gh = new GitHub("team/project", async (_c, args) => {
    calls.push(args);
    return ++count === 1
      ? 'HTTP/2.0 200 OK\nETag: "one"\n\n[{"id":1}]'
      : "HTTP/2.0 304 Not Modified\n\n";
  });
  assert.deepEqual(await gh.list("/issues"), [{ id: 1 }]);
  assert.deepEqual(await gh.list("/issues"), [{ id: 1 }]);
  assert(calls[1].includes('If-None-Match: "one"'));
  const foreign = new GitHub(
    "team/project",
    async () =>
      'HTTP/2.0 200 OK\nLink: <https://evil.example/page>; rel="next"\n\n[]',
  );
  await assert.rejects(foreign.list("/issues"), /pagination link/);
});

test("rate-limit headers preserve the server retry deadline without leaking error bodies", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const gh = new GitHub("team/project", async () => {
    throw {
      details: "HTTP 403 secret",
      output: `HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: ${reset}\n\nsecret body`,
    };
  });
  await assert.rejects(
    gh.list("/issues"),
    (e) =>
      e.status === 403 &&
      e.retryAt === reset * 1000 &&
      !e.message.includes("secret"),
  );
});

test("case-insensitive repository pagination works and malformed responses stay private", async () => {
  const gh = new GitHub("team/project", async (_command, args) =>
    args.some((a) => a.includes("page=2"))
      ? "HTTP/2.0 200 OK\n\n[]"
      : 'HTTP/2.0 200 OK\nLink: <https://api.github.com/repos/Team/Project/issues?page=2>; rel="next"\n\n[{"id":1}]',
  );
  assert.deepEqual(await gh.list("/issues"), [{ id: 1 }]);
  const bad = new GitHub(
    "team/project",
    async () => "HTTP/2.0 200 OK\n\nprivate-not-json",
  );
  await assert.rejects(
    bad.list("/issues"),
    (e) => e.status === 0 && !e.message.includes("private"),
  );
});
