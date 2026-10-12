import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, GitHubError } from "../packages/cli/lib/github.js";
import { createBoard } from "../packages/cli/lib/board.js";
import { writeJSON } from "../packages/cli/lib/store.js";

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
export class FakeGitHub {
  constructor() {
    this.repo = "team/project";
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
  }
  time() {
    return new Date(1700000000000 + ++this.counter * 1000).toISOString();
  }
  async verify(expected = {}) {
    if (this.offline) throw new GitHubError(0);
    if (expected.ownerId && expected.ownerId !== this.user.id)
      throw new Error("GitHub account changed");
    return {
      user: this.user,
      repo: { id: this.repoId, has_issues: true, permissions: { push: true } },
    };
  }
  async api(method, suffix = "", data) {
    this.calls++;
    if (this.offline) throw new GitHubError(0);
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
    return structuredClone(result);
  }
  async perform(method, suffix, data) {
    let m;
    if ((m = suffix.match(/^\/collaborators\/([^/]+)\/permission$/)))
      return { permission: this.blockedUsers.has(m[1]) ? "read" : "write" };
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
        if (i.state !== data.state)
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
      return c;
    }
    if ((m = suffix.match(/^\/issues\/comments\/(\d+)$/))) {
      const c = this.comments.find((c) => c.id === +m[1]);
      if (!c) throw new GitHubError(404);
      return c;
    }
    if ((m = suffix.match(/^\/issues\/(\d+)\/labels(?:\/(.+))?$/))) {
      const i = this.issues.find((x) => x.number === +m[1]);
      if (method === "POST") {
        for (const name of data.labels)
          if (!i.labels.some((x) => x.name === name)) i.labels.push({ name });
      } else if (method === "DELETE")
        i.labels = i.labels.filter((x) => x.name !== decodeURIComponent(m[2]));
      return i.labels;
    }
    throw new Error(`Unexpected API ${method} ${suffix}`);
  }
  async list(suffix) {
    this.calls++;
    if (this.offline) throw new GitHubError(0);
    let out = [],
      m;
    if (suffix === "/labels") out = this.labels;
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
    return structuredClone(out);
  }
}
export async function connection(t, gh = new FakeGitHub()) {
  const dir = await temporary(t),
    file = path.join(dir, "connection.json"),
    board = await createBoard(gh);
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
