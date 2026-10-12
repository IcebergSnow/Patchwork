// Deterministic HTTP-contract benchmark; no GitHub account/network required.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { connection, restClient } from "../tests/fixtures.js";
import { register, snapshot } from "../packages/cli/lib/board.js";
import { withBoard, accountFile } from "../packages/cli/lib/sync.js";
import { readJSON } from "../packages/cli/lib/store.js";
const cleanup = [],
  previous = process.env.PATCHWORK_HOME;
try {
  const { file, gh: remote } = await connection({
    after: (fn) => cleanup.push(fn),
  });
  const c = await readJSON(file);
  for (let n = 1; n <= 5; n++) {
    remote.user = { id: n, login: `teammate-${n}` };
    await register(
      remote,
      c.board,
      { id: randomUUID(), name: `Chat ${n}`, client: "codex", ownerId: n },
      true,
      randomUUID(),
    );
  }
  remote.user = { id: 1, login: "teammate-1" };
  for (let n = 0; n < 20; n++) {
    const issue = await remote.api("POST", "/issues", {
      title: `Request ${n}`,
      body: "Benchmark request",
      labels: ["patchwork"],
    });
    if (n < 15)
      await remote.api("PATCH", `/issues/${issue.number}`, { state: "closed" });
  }
  const gh = restClient(remote);
  let baseline = 0;
  gh.onResponse = () => baseline++;
  await gh.verify(c);
  await snapshot(gh, c.board);
  gh.release();
  let now = Date.now();
  const clock = () => now;
  const check = () =>
    withBoard(
      c,
      gh,
      async (sync) => {
        await sync.poll();
        return sync.view();
      },
      clock,
    );
  const count = async () =>
    (await readJSON(accountFile(c)))?.stats.requests || 0;
  const measure = async (fn) => {
    const before = await count();
    await fn();
    return (await count()) - before;
  };
  const initial = await measure(check);
  now += 60000;
  const idle = await measure(check);
  const shared = await measure(() => Promise.all([check(), check(), check()]));
  await remote.api("POST", "/issues/21/comments", {
    body: "A meaningful update",
  });
  now += 60000;
  const active = await measure(check);
  assert.deepEqual(
    { baseline, initial, idle, active, shared },
    { baseline: 51, initial: 51, idle: 3, active: 4, shared: 0 },
  );
  console.log(
    JSON.stringify(
      {
        fixture:
          "20 requests (15 closed), 5 GitHub users; one page per collection",
        baselineFullCheck: baseline,
        optimized: {
          initial,
          idleCheck: idle,
          changedRequestCheck: active,
          threeAdditionalChatsWithin15Seconds: shared,
        },
        reduction: {
          idle: `${Math.round((1 - idle / baseline) * 100)}%`,
          active: `${Math.round((1 - active / baseline) * 100)}%`,
        },
        note: "Counts are HTTP attempts, including conditional GETs; periodic reconciliation, verification expiry and writes are additional. No real GitHub calls.",
      },
      null,
      2,
    ),
  );
} finally {
  for (const fn of cleanup.reverse()) await fn();
  if (previous === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = previous;
}
