import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, GitHub, GitHubError } from "../packages/cli/lib/github.js";
import { createBoard } from "../packages/cli/lib/board.js";
import { writeJSON, digest } from "../packages/cli/lib/store.js";

export async function temporary(t) {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "patchwork-test-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export async function gitProject(t) {
  const dir = await temporary(t);
  await run("git", ["init", dir]);
  return dir;
}
export class FakeGitHub extends GitHub {
  constructor() {
    super("team/project");
    this.user = { id: 1, login: "alice" };
    this.repoId = 99;
    this.issues = [];
    this.comments = [];
    this.events = [];
    this.labels = [];
    this.counter = 0;
    this.fail = null;
    this.calls = 0;
    this.blockedUsers = new Set();
    this.managers = new Set();
  }
  time() {
    return new Date(1700000000000 + ++this.counter * 1000).toISOString();
  }
  async credentials() {
    this.credential = `test-credential-${this.user.id}-${this.tokenVersion || 0}`;
    return this.credential;
  }
  async pin() {}
  async commentEditors(ids) {
    return this.response("GET", "/graphql", () =>
      ids.map((id) => {
        const c = this.comments.find((c) => c.node_id === id);
        return c
          ? {
              id,
              body: c.body,
              updatedAt: c.updated_at,
              author: { id: `user:${c.user.id}` },
              editor: { id: `user:${c.editor?.id || c.user.id}` },
              issue: { repository: { nameWithOwner: this.repo } },
            }
          : null;
      }),
    );
  }
  async request(method, endpoint, data) {
    if (endpoint === "/user")
      return this.response(method, endpoint, () => ({ ...this.user }));
    return this.api(method, endpoint.replace(`/repos/${this.repo}`, ""), data);
  }
  async response(method, suffix, fn) {
    this.beforeRequest?.();
    this.calls++;
    (this.history ||= []).push({ method, suffix });
    this.serverTime = 1700000000000 + this.counter * 1000;
    try {
      if (this.offline) throw new GitHubError(0);
      const value = await fn();
      this.onResponse?.({ method, status: 200 });
      return structuredClone(value);
    } catch (error) {
      this.onResponse?.({ method, status: error.status || 0, error });
      throw error;
    }
  }
  async api(method, suffix = "", data) {
    return this.response(method, suffix, async () => {
      if (
        this.fail?.method === method &&
        this.fail.suffix === suffix &&
        !this.fail.after
      ) {
        this.fail = null;
        throw new GitHubError(500);
      }
      const result = await this.perform(method, suffix, data);
      if (
        this.fail?.method === method &&
        this.fail.suffix === suffix &&
        this.fail.after
      ) {
        this.fail = null;
        throw new GitHubError(500);
      }
      return result;
    });
  }
  async perform(method, suffix, data) {
    let m;
    if (suffix === "")
      return {
        id: this.repoId,
        has_issues: true,
        archived: false,
        permissions: { push: !this.noWrite },
      };
    if ((m = suffix.match(/^\/collaborators\/([^/]+)\/permission$/)))
      return {
        permission: this.blockedUsers.has(m[1])
          ? "read"
          : this.managers.has(m[1])
            ? "maintain"
            : "write",
      };
    if (suffix === "/labels" && method === "POST") {
      this.labels.push(data);
      return data;
    }
    if (suffix === "/issues" && method === "POST") {
      const time = this.time(),
        number = this.issues.length + 1;
      const i = {
        id: ++this.counter,
        number,
        title: data.title,
        body: data.body,
        labels: data.labels.map((name) => ({ name })),
        state: "open",
        created_at: time,
        updated_at: time,
        user: { ...this.user },
        html_url: `https://github.com/${this.repo}/issues/${number}`,
      };
      this.issues.push(i);
      return i;
    }
    if ((m = suffix.match(/^\/issues\/(\d+)$/))) {
      const i = this.issues.find((x) => x.number === +m[1]);
      if (!i) throw new GitHubError(404);
      if (method === "PATCH") {
        if (data.state && i.state !== data.state)
          this.events.push({
            id: ++this.counter,
            issue: i.number,
            event: data.state === "open" ? "reopened" : "closed",
            actor: { ...this.user },
            created_at: this.time(),
          });
        Object.assign(i, data, { updated_at: this.time() });
      }
      return i;
    }
    if (
      (m = suffix.match(/^\/issues\/(\d+)\/comments$/)) &&
      method === "POST"
    ) {
      const time = this.time(),
        id = ++this.counter;
      const c = {
        id,
        node_id: `comment:${id}`,
        thread: +m[1],
        body: data.body,
        user: { ...this.user },
        author_association: "COLLABORATOR",
        created_at: time,
        updated_at: time,
        issue_url: `https://api.github.com/repos/${this.repo}/issues/${m[1]}`,
        html_url: `https://github.com/${this.repo}/issues/${m[1]}#issuecomment-${id}`,
      };
      this.comments.push(c);
      const issue = this.issues.find((i) => i.number === +m[1]);
      issue.updated_at = time;
      issue.comments = (issue.comments || 0) + 1;
      return c;
    }
    if ((m = suffix.match(/^\/issues\/comments\/(\d+)$/))) {
      const c = this.comments.find((c) => c.id === +m[1]);
      if (!c) throw new GitHubError(404);
      if (method === "PATCH")
        Object.assign(c, data, {
          updated_at: this.time(),
          editor: { ...this.user },
        });
      if (method === "DELETE")
        this.comments = this.comments.filter((x) => x.id !== c.id);
      return c;
    }
    if ((m = suffix.match(/^\/issues\/(\d+)\/labels(?:\/(.+))?$/))) {
      const i = this.issues.find((x) => x.number === +m[1]);
      if (method === "POST") {
        for (const name of data.labels)
          if (!i.labels.some((x) => x.name === name)) i.labels.push({ name });
      } else if (method === "DELETE")
        i.labels = i.labels.filter((x) => x.name !== decodeURIComponent(m[2]));
      i.updated_at = this.time();
      return i.labels;
    }
    throw new Error(`Unexpected API ${method} ${suffix}`);
  }
  async list(suffix) {
    return this.response("GET", suffix, () => {
      let out = [],
        m;
      const q = new URLSearchParams(suffix.split("?")[1]);
      if (suffix.startsWith("/issues/comments?")) out = this.comments;
      else if (suffix === "/labels") out = this.labels;
      else if (suffix.startsWith("/issues?")) {
        const q = new URLSearchParams(suffix.split("?")[1]);
        out = this.issues.filter(
          (i) =>
            (!q.get("labels") ||
              i.labels.some((l) => l.name === q.get("labels"))) &&
            (q.get("state") === "all" || i.state === "open"),
        );
      } else if ((m = suffix.match(/^\/issues\/(\d+)\/comments/)))
        out = this.comments.filter((c) => c.thread === +m[1]);
      else if ((m = suffix.match(/^\/issues\/(\d+)\/events/)))
        out = this.events.filter((c) => c.issue === +m[1]);
      else throw new Error("Unexpected list " + suffix);
      if (q.get("since"))
        out = out.filter(
          (x) => Date.parse(x.updated_at) > Date.parse(q.get("since")),
        );
      return out;
    });
  }
}
export async function connection(t, gh = new FakeGitHub()) {
  const dir = await temporary(t),
    file = path.join(dir, "connection.json"),
    board = await createBoard(gh);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  await writeJSON(file, {
    version: 1,
    enabled: true,
    root: dir,
    client: "codex",
    repo: gh.repo,
    repoId: 99,
    ownerId: 1,
    name: "Alice / Codex",
    board: board.number,
    boardUrl: board.html_url,
  });
  return { file, dir, gh, board };
}

// Exercise the REAL transport, pagination, conditional GETs and credentials
// boundary while keeping test data and HTTP replies deterministic and offline.
export function restClient(remote, { pageSize = 100, intercept } = {}) {
  return new GitHub(remote.repo, async (_command, args, options) => {
    if (args[0] === "auth")
      return `private-test-token-${remote.user.id}-${remote.tokenVersion || 0}`;
    const method = args[args.indexOf("--method") + 1],
      endpoint = args.find((x) => x.startsWith("/"));
    try {
      await intercept?.({ method, endpoint, args, options });
      const url = new URL(`https://api.github.com${endpoint}`),
        suffix = endpoint.replace(`/repos/${remote.repo}`, "");
      const listing =
        method === "GET" &&
        (/^\/issues\?/.test(suffix) ||
          /^\/issues\/comments\?/.test(suffix) ||
          /^\/issues\/\d+\/(comments|events)(\?|$)/.test(suffix) ||
          suffix.startsWith("/labels?"));
      let value =
        endpoint === "/graphql"
          ? {
              data: {
                nodes: await remote.commentEditors(
                  JSON.parse(options.input).variables.ids,
                ),
              },
            }
          : listing
            ? await remote.list(suffix)
            : endpoint === "/user"
              ? await remote.request(method, endpoint)
              : await remote.api(
                  method,
                  suffix,
                  options?.input ? JSON.parse(options.input) : undefined,
                );
      let next = "";
      if (listing) {
        const page = Number(url.searchParams.get("page") || 1),
          start = (page - 1) * pageSize;
        if (start + pageSize < value.length) {
          url.searchParams.set("page", page + 1);
          next = `Link: <${url}>; rel="next"\n`;
        }
        value = value.slice(start, start + pageSize);
      }
      const etag = `"${digest(JSON.stringify(value))}"`,
        date = new Date(remote.serverTime).toUTCString();
      if (args.includes(`If-None-Match: ${etag}`))
        return `HTTP/2.0 304 Not Modified\nDate: ${date}\n\n`;
      return `HTTP/2.0 200 OK\nDate: ${date}\nETag: ${etag}\n${next}\n${JSON.stringify(value)}`;
    } catch (e) {
      throw { details: `HTTP ${e.status || 503}`, output: e.headers || "" };
    }
  });
}
