import path from "node:path";
import { home, digest, locked, readJSON, writeJSON } from "./store.js";
import { GitHubError } from "./github.js";
import { assertBoard, fullRecords, isRequest, project } from "./board.js";

export const POLL_INTERVAL = 30_000,
  PROMPT_INTERVAL = 15_000;
export const RECONCILE_INTERVAL = 15 * 60_000,
  OVERLAP = 120_000;
export const accountFile = (c) =>
  path.join(home(), "github", `account-${c.ownerId}.json`);
export const boardFile = (c) =>
  path.join(
    home(),
    "github",
    `${digest(`${c.ownerId}:${c.repoId}:${c.repo.toLowerCase()}:${c.board}`)}.json`,
  );
const merge = (old, updates) => {
  const records = new Map(old.map((x) => [x.id, x]));
  for (const value of updates) {
    const prior = records.get(value.id);
    records.set(
      value.id,
      prior?.body === value.body && prior?.updated_at === value.updated_at
        ? { ...value, editProof: prior?.editProof || value.editProof }
        : value,
    );
  }
  return [...records.values()];
};
const thread = (comment) => Number(comment.issue_url?.split("/").at(-1));

// Keep only fields used by Patchwork, rather than duplicating GitHub's large
// user, reaction and repository objects in a second database.
const fields = (value, names) =>
  Object.fromEntries(
    names.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  );
function compact(value, kind) {
  const result = fields(
    value,
    kind === "issue"
      ? [
          "id",
          "number",
          "title",
          "body",
          "state",
          "labels",
          "created_at",
          "updated_at",
          "html_url",
          "pull_request",
          "comments",
        ]
      : kind === "comment"
        ? [
            "id",
            "node_id",
            "body",
            "created_at",
            "updated_at",
            "issue_url",
            "html_url",
            "editProof",
          ]
        : ["id", "event", "created_at"],
  );
  for (const key of ["user", "actor"])
    if (value[key]) result[key] = fields(value[key], ["id", "login"]);
  if (result.labels)
    result.labels = result.labels.map((l) =>
      typeof l === "string" ? l : l.name,
    );
  return result;
}
function trimRecords(records) {
  return {
    board: compact(records.board, "issue"),
    comments: merge([], records.comments).map((c) => compact(c, "comment")),
    requests: Object.fromEntries(
      Object.entries(records.requests).map(([id, r]) => [
        id,
        {
          issue: compact(r.issue, "issue"),
          comments: merge([], r.comments).map((c) => compact(c, "comment")),
          events: merge([], r.events)
            .filter((e) => ["closed", "reopened"].includes(e.event))
            .map((e) => compact(e, "event")),
        },
      ]),
    ),
  };
}
function httpCache(gh, board) {
  const entries = [];
  let bytes = 0;
  const priority = (key) =>
    key === `/repos/${gh.repo}/issues/${board}`
      ? 0
      : key.includes("/issues?")
        ? 1
        : 2;
  for (const entry of [...gh.etags]
    .reverse()
    .sort((a, b) => priority(a[0]) - priority(b[0]))) {
    if (entry[0].includes("since=")) continue;
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > 512_000 || entries.length >= 32) continue;
    entries.unshift(entry);
    bytes += size;
  }
  return entries;
}

class BoardSync {
  constructor(c, gh, account, cache, clock) {
    Object.assign(this, { c, gh, account, cache, clock });
  }
  async poll(maxAge = PROMPT_INTERVAL) {
    const now = this.clock(),
      { gh, c } = this;
    if (
      this.cache.records &&
      now >= this.cache.checkedAt &&
      now - this.cache.checkedAt < maxAge
    )
      return;
    // Fetch the board first: its server Date anchors the window BEFORE any
    // paginated reads. Local clock skew must never advance a remote cursor.
    const board = await gh.api("GET", `/issues/${c.board}`);
    const started = gh.serverTime;
    assertBoard(board);
    if (this.cache.records && this.cache.records.board.id !== board.id)
      throw new Error("GitHub board identity changed. Reconnect explicitly.");
    const full =
      !this.cache.records ||
      !this.cache.since ||
      now < this.cache.checkedAt ||
      now - this.cache.reconciledAt >= RECONCILE_INTERVAL;
    let records;
    if (full) {
      records = await fullRecords(gh, c.board, board);
    } else {
      records = structuredClone(this.cache.records);
      records.board = board;
      const since = encodeURIComponent(
        new Date(Math.max(0, this.cache.since - OVERLAP)).toISOString(),
      );
      // Include unlabelled changed issues so removing the Patchwork label is
      // observed. Stable creation order avoids updated-order pagination churn.
      const issues = await gh.list(
        `/issues?state=all&sort=created&direction=asc&since=${since}`,
      );
      for (const issue of issues) {
        if (!isRequest(issue, c.board)) {
          delete records.requests[issue.number];
          continue;
        }
        const old = records.requests[issue.number];
        if (!old) {
          records.requests[issue.number] = {
            issue,
            comments: await gh.list(`/issues/${issue.number}/comments`),
            events: await gh.list(`/issues/${issue.number}/events`),
          };
        } else if (
          JSON.stringify(compact(issue, "issue")) !== JSON.stringify(old.issue)
        ) {
          old.issue = issue;
          // Events have no `since` API. Read them only for changed issues, to
          // preserve a close/reopen pair even when the final state is unchanged.
          old.events = await gh.list(`/issues/${issue.number}/events`);
        }
      }
      // Repository-wide `since` includes EDITED comments, even on old closed
      // requests and even if GitHub did not change the parent issue timestamp.
      const comments = await gh.list(
        `/issues/comments?sort=created&direction=asc&since=${since}`,
      );
      records.comments = merge(
        records.comments,
        comments.filter((x) => thread(x) === c.board),
      );
      for (const comment of comments) {
        const request = records.requests[thread(comment)];
        if (request) request.comments = merge(request.comments, [comment]);
      }
    }
    // Commit only a COMPLETE traversal. A failed page or killed process cannot
    // move the watermark; the overlap plus periodic full reconciliation also
    // catches late visibility, deletions and changes during pagination.
    this.cache = {
      ...this.cache,
      records: trimRecords(records),
      checkedAt: now,
      since: Number.isFinite(started) ? started : this.cache.since,
      reconciledAt: full ? now : this.cache.reconciledAt,
    };
  }
  async view() {
    const key = this.c.repoId;
    this.account.permissions[key] ??= {};
    return project(
      this.gh,
      this.cache.records,
      this.account.permissions[key],
      this.clock(),
    );
  }
  async authorize() {
    try {
      await this.gh.verify(this.c, {
        cache: this.account.auth,
        now: this.clock(),
        write: true,
      });
    } catch (e) {
      this.account.auth = {};
      this.account.permissions = {};
      this.gh.etags.clear();
      throw e;
    }
  }
  async accept(value) {
    if (!value || value.unchanged) return;
    const records = this.cache.records;
    if (value.number) {
      const old = records.requests[value.number];
      records.requests[value.number] = {
        issue: value,
        comments:
          old?.comments ||
          (await this.gh.list(`/issues/${value.number}/comments`)),
        events: await this.gh.list(`/issues/${value.number}/events`),
      };
    } else if (value.issue_url) {
      const number = thread(value);
      if (number === this.c.board)
        records.comments = merge(records.comments, [value]);
      else if (records.requests[number])
        records.requests[number].comments = merge(
          records.requests[number].comments,
          [value],
        );
    }
    this.cache.records = trimRecords(records);
  }
  labels(request) {
    if (this.cache.records.requests[request.number])
      this.cache.records.requests[request.number].issue.labels = request.labels;
  }
  async save() {
    if (this.cache.records)
      await writeJSON(boardFile(this.c), {
        ...this.cache,
        http: httpCache(this.gh, this.c.board),
      });
  }
}

// One account lock coalesces readers across projects, worktrees and clients and
// shares rate-limit backoff. No daemon; all work is driven by the existing hooks.
export async function withBoard(c, gh, fn, clock = Date.now) {
  return locked(accountFile(c), async () => {
    const account = (await readJSON(accountFile(c))) || {
      version: 1,
      auth: {},
      permissions: {},
      stats: {
        since: new Date(clock()).toISOString(),
        requests: 0,
        reads: 0,
        writes: 0,
        notModified: 0,
        failures: 0,
      },
    };
    const failuresBefore = account.stats.failures;
    let sync;
    const invalidate = () => {
      account.auth = {};
      account.permissions = {};
      gh.etags.clear();
    };
    let authenticated = false;
    try {
      const credential = await gh.credentials();
      if (account.credential !== credential) {
        invalidate();
        account.credential = credential;
      }
      gh.beforeRequest = () => {
        if (account.retryAt > clock())
          throw new GitHubError(account.lastStatus, account.retryAt);
      };
      gh.onResponse = ({ method, status, error, count = true }) => {
        if (count) {
          account.stats.requests++;
          account.stats[method === "GET" ? "reads" : "writes"]++;
        }
        if (status === 304) {
          account.stats.notModified++;
          return;
        }
        if (!error) return;
        account.stats.failures++;
        if ([401, 403].includes(status)) invalidate();
        if ([0, 401, 403, 429].includes(status) || status >= 500) {
          account.failures = Math.min((account.failures || 0) + 1, 5);
          account.retryAt = Math.max(
            error.retryAt || 0,
            clock() + Math.min(60_000 * 2 ** (account.failures - 1), 900_000),
          );
          account.lastStatus = status;
          error.retryAt = account.retryAt;
        }
      };
      gh.beforeRequest();
      try {
        await gh.verify(c, { cache: account.auth, now: clock() });
        authenticated = true;
      } catch (e) {
        invalidate();
        throw e;
      }
      let cache;
      try {
        cache = await readJSON(boardFile(c));
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      } // Disposable; recover from damaged cache.
      if (
        !cache ||
        cache.version !== 1 ||
        cache.repoId !== c.repoId ||
        cache.board !== c.board
      )
        cache = { version: 1, repoId: c.repoId, board: c.board };
      gh.etags = new Map(
        cache.credential === credential ? cache.http || [] : [],
      );
      cache.credential = credential;
      sync = new BoardSync(c, gh, account, cache, clock);
      const result = await fn(sync);
      await sync.save();
      if (account.stats.failures === failuresBefore) {
        account.failures = 0;
        account.retryAt = 0;
      }
      return result;
    } catch (e) {
      // A handled collaborator 404 means that person is not a writer; retain
      // that negative result. An unhandled 404 may mean lost repository access.
      if (e.status === 404) invalidate();
      throw e;
    } finally {
      if (!authenticated) invalidate();
      gh.release();
      // Counts are numeric aggregates only: no credentials, paths, bodies or URLs.
      await writeJSON(accountFile(c), account);
    }
  });
}
