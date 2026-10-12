import { spawn } from "node:child_process";
import { digest } from "./store.js";

export const VERIFY_TTL = 300_000;

export function run(command, args, { input, cwd, env, timeout = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      size = 0;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_000_000) child.kill();
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8000) stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`${command} is unavailable. Install it and retry.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(
            Object.assign(
              new Error(
                `${command} failed. Check installation, authentication, permissions, and connectivity.`,
              ),
              { details: stderr, output: stdout },
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export function repository(value) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || "") ||
    value.split("/").some((x) => x === "." || x === "..")
  )
    throw new Error("Use a github.com repository in OWNER/REPO form.");
  return value;
}
export class GitHubError extends Error {
  constructor(status, retryAt = 0) {
    super(
      `GitHub request failed (${status || "network/timeout"}). Check gh auth status, repository permissions, and connectivity; rate limits may require waiting.`,
    );
    this.status = status;
    this.retryAt = retryAt;
  }
}
function failure(error) {
  const status = Number(error.details?.match(/HTTP (\d{3})/)?.[1]) || 0;
  const headers = error.output || "";
  const serverNow = Date.parse(headers.match(/^date:\s*(.+)$/im)?.[1]);
  const localDeadline = (utc) =>
    Number.isFinite(serverNow)
      ? Date.now() + Math.max(0, utc - serverNow)
      : utc;
  const retry = headers.match(/^retry-after:\s*(.+)$/im)?.[1].trim();
  let retryAt = retry
    ? /^\d+$/.test(retry)
      ? Date.now() + Number(retry) * 1000
      : localDeadline(Date.parse(retry))
    : 0;
  if (/^x-ratelimit-remaining:\s*0\s*$/im.test(headers))
    retryAt = Math.max(
      retryAt || 0,
      localDeadline(
        Number(headers.match(/^x-ratelimit-reset:\s*(\d+)/im)?.[1] || 0) * 1000,
      ),
    );
  return new GitHubError(status, Number.isFinite(retryAt) ? retryAt : 0);
}
export class GitHub {
  constructor(repo, runner = run) {
    this.repo = repository(repo);
    this.runner = runner;
    this.etags = new Map();
  }
  async credentials() {
    try {
      const token = (
        await this.runner("gh", ["auth", "token", "--hostname", "github.com"])
      ).trim();
      if (!token) throw new Error();
      // Pin this operation to exactly the credential we verified. Never put it
      // in argv, logs, the durable cache, or an error. gh still owns storage.
      this.env = {
        ...process.env,
        GH_TOKEN: token,
        GITHUB_TOKEN: "",
        GH_DEBUG: "",
      };
      this.credential = digest(token);
      return this.credential;
    } catch {
      this.release();
      throw new Error(
        "GitHub credentials unavailable. Check gh auth status and reconnect.",
      );
    }
  }
  release() {
    this.env = undefined;
    this.credential = undefined;
    this.beforeRequest = undefined;
    this.onResponse = undefined;
  }
  async send(args, options, method) {
    this.beforeRequest?.();
    try {
      const raw = await this.runner("gh", args, { ...options, env: this.env });
      const date = Date.parse(raw.match(/^date:\s*(.+)$/im)?.[1]);
      if (Number.isFinite(date)) this.serverTime = date;
      this.onResponse?.({
        method,
        status: Number(raw.match(/^HTTP\/[^ ]+ (\d+)/)?.[1]) || 200,
      });
      return raw;
    } catch (e) {
      const error = failure(e);
      this.onResponse?.({ method, status: error.status, error });
      throw error;
    }
  }
  async request(method, endpoint, data) {
    // All endpoints are built locally. No arbitrary URL, host, or shell expansion.
    if (
      !(
        endpoint === "/user" ||
        endpoint === `/repos/${this.repo}` ||
        endpoint.startsWith(`/repos/${this.repo}/`)
      )
    )
      throw new Error("Endpoint is outside the connected repository.");
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      method,
      "--include",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      endpoint,
    ];
    if (data !== undefined) args.push("--input", "-");
    try {
      const raw = await this.send(
        args,
        {
          input: data === undefined ? undefined : JSON.stringify(data),
        },
        method,
      );
      const boundary = raw.search(/\r?\n\r?\n/);
      const body =
        raw.startsWith("HTTP/") && boundary >= 0
          ? raw.slice(boundary).trim()
          : raw.trim();
      const value = body ? JSON.parse(body) : null;
      return value;
    } catch (e) {
      if (e instanceof GitHubError) throw e;
      const error = failure(e);
      this.onResponse?.({ method, status: error.status, error, count: false });
      throw error; // Never echo remote bodies or credentials.
    }
  }
  api(method, suffix = "", body) {
    return method === "GET" && suffix && !suffix.startsWith("/collaborators/")
      ? this.get(`/repos/${this.repo}${suffix}`).then((x) => x.value)
      : this.request(method, `/repos/${this.repo}${suffix}`, body);
  }
  // REST attributes edited comments to their ORIGINAL author. Check the editor
  // only for changed comments, in batches; never treat editor-supplied metadata
  // as an instruction from the original author's agent.
  async commentEditors(ids) {
    const query = `query($ids:[ID!]!) { nodes(ids:$ids) { ... on IssueComment {
      id body updatedAt author { ... on Node { id } } editor { ... on Node { id } }
      issue { repository { nameWithOwner } }
    } } }`;
    const raw = await this.send(
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "--include",
        "/graphql",
        "--input",
        "-",
      ],
      { input: JSON.stringify({ query, variables: { ids } }) },
      "GET", // A GraphQL read, for aggregate API accounting.
    );
    try {
      const boundary = raw.search(/\r?\n\r?\n/);
      const value = JSON.parse(
        raw.startsWith("HTTP/") ? raw.slice(boundary).trim() : raw,
      );
      if (value.errors?.length || !Array.isArray(value.data?.nodes)) throw 0;
      return value.data.nodes;
    } catch {
      const error = new GitHubError(0);
      this.onResponse?.({ method: "GET", status: 0, error, count: false });
      throw error;
    }
  }
  async pin(number) {
    try {
      await this.runner(
        "gh",
        ["issue", "pin", String(number), "--repo", `github.com/${this.repo}`],
        { env: this.env },
      );
    } catch {
      /* Board remains usable if pin slots or permissions prevent pinning. */
    }
  }
  async get(endpoint) {
    if (
      !endpoint.toLowerCase().startsWith(`/repos/${this.repo.toLowerCase()}/`)
    )
      throw new Error("Endpoint is outside the connected repository.");
    const cached = this.etags.get(endpoint);
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      endpoint,
    ];
    // A full terminal page can gain a next link without changing its body.
    // A body-only ETag/304 must not freeze that pagination boundary forever.
    const pageSize =
      Number(
        new URL(endpoint, "https://api.github.com").searchParams.get(
          "per_page",
        ),
      ) || 30;
    const fullTerminalPage =
      Array.isArray(cached?.value) &&
      cached.value.length >= pageSize &&
      !cached.next;
    if (cached?.etag && !fullTerminalPage)
      args.push("-H", `If-None-Match: ${cached.etag}`);
    let raw;
    try {
      raw = await this.send(args, undefined, "GET");
    } catch (e) {
      const error = e instanceof GitHubError ? e : failure(e);
      if (error.status === 304 && cached) return cached;
      throw error;
    }
    const boundary = raw.search(/\r?\n\r?\n/);
    const header =
      raw.startsWith("HTTP/") && boundary >= 0 ? raw.slice(0, boundary) : "";
    const code = Number(header.match(/^HTTP\/[^ ]+ (\d+)/)?.[1]);
    if (code === 304 && cached) return cached;
    const body = header ? raw.slice(boundary).trim() : raw;
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      const error = new GitHubError(0);
      this.onResponse?.({ method: "GET", status: 0, error, count: false });
      throw error;
    }
    const etag = header.match(/^etag:\s*(.+)$/im)?.[1].trim();
    const link = header.match(/^link:\s*(.+)$/im)?.[1];
    const nextURL = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    let next;
    if (nextURL) {
      let url;
      try {
        url = new URL(nextURL);
      } catch {
        throw new Error("Invalid GitHub pagination link.");
      }
      if (
        url.origin !== "https://api.github.com" ||
        url.username ||
        url.password ||
        !url.pathname
          .toLowerCase()
          .startsWith(`/repos/${this.repo.toLowerCase()}/`)
      )
        throw new Error("Invalid GitHub pagination link.");
      next = url.pathname + url.search;
    }
    const result = { value, etag, next };
    this.etags.set(endpoint, result);
    if (this.etags.size > 256)
      this.etags.delete(this.etags.keys().next().value);
    return result;
  }
  async list(suffix) {
    let endpoint = `/repos/${this.repo}${suffix}${suffix.includes("?") ? "&" : "?"}per_page=100`;
    const items = [],
      visited = new Set();
    while (endpoint) {
      if (visited.has(endpoint) || visited.size >= 1000)
        throw new Error(
          "GitHub pagination did not finish; retry without advancing the cursor.",
        );
      visited.add(endpoint);
      const page = await this.get(endpoint);
      if (!Array.isArray(page.value))
        throw new Error("Invalid GitHub list response.");
      items.push(...page.value);
      endpoint = page.next;
    }
    return items;
  }
  async verify(
    expected = {},
    { cache = {}, now = Date.now(), write = false } = {},
  ) {
    if (!this.credential) await this.credentials();
    if (cache.credential !== this.credential) {
      for (const key of Object.keys(cache)) delete cache[key];
      cache.credential = this.credential;
      this.etags.clear();
    }
    cache.repos ??= {};
    const fresh = (entry) =>
      entry && now >= entry.at && now - entry.at < VERIFY_TTL;
    const user = fresh(cache.user)
      ? cache.user.value
      : await this.request("GET", "/user");
    cache.user = {
      at: fresh(cache.user) ? cache.user.at : now,
      value: { id: user.id, login: user.login },
    };
    if (expected.ownerId && expected.ownerId !== user.id) {
      delete cache.user;
      throw new Error(
        "GitHub account changed. Switch back to the account used for this connection.",
      );
    }
    const key = this.repo.toLowerCase(),
      old = cache.repos[key];
    // A cached read authorization never authorizes a mutation. Recheck current
    // repository permissions for writes using the same pinned credential.
    const repo = !write && fresh(old) ? old.value : await this.api("GET");
    if (!repo.has_issues || repo.archived || !repo.permissions?.push) {
      delete cache.repos[key];
      throw new Error(
        "Patchwork needs an unarchived repository with Issues enabled and repository write access.",
      );
    }
    if (expected.repoId && expected.repoId !== repo.id) {
      delete cache.repos[key];
      throw new Error("Repository identity changed. Reconnect explicitly.");
    }
    cache.repos[key] = {
      at: !write && fresh(old) ? old.at : now,
      value: {
        id: repo.id,
        has_issues: repo.has_issues,
        archived: repo.archived,
        permissions: { push: repo.permissions.push },
      },
    };
    return { user, repo };
  }
}
