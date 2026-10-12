import { spawn } from "node:child_process";

export function run(command, args, { input, cwd, timeout = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
  const retry = headers.match(/^retry-after:\s*(.+)$/im)?.[1].trim();
  let retryAt = retry
    ? /^\d+$/.test(retry)
      ? Date.now() + Number(retry) * 1000
      : Date.parse(retry)
    : 0;
  if (/^x-ratelimit-remaining:\s*0\s*$/im.test(headers))
    retryAt = Math.max(
      retryAt || 0,
      Number(headers.match(/^x-ratelimit-reset:\s*(\d+)/im)?.[1] || 0) * 1000,
    );
  return new GitHubError(status, Number.isFinite(retryAt) ? retryAt : 0);
}
export class GitHub {
  constructor(repo, runner = run) {
    this.repo = repository(repo);
    this.runner = runner;
    this.etags = new Map();
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
      const raw = await this.runner("gh", args, {
        input: data === undefined ? undefined : JSON.stringify(data),
      });
      const boundary = raw.search(/\r?\n\r?\n/);
      const body =
        raw.startsWith("HTTP/") && boundary >= 0
          ? raw.slice(boundary).trim()
          : raw.trim();
      const value = body ? JSON.parse(body) : null;
      return value;
    } catch (e) {
      throw failure(e); // Never echo remote bodies or credentials.
    }
  }
  api(method, suffix = "", body) {
    return method === "GET" && suffix && !suffix.startsWith("/collaborators/")
      ? this.get(`/repos/${this.repo}${suffix}`).then((x) => x.value)
      : this.request(method, `/repos/${this.repo}${suffix}`, body);
  }
  async pin(number) {
    try {
      await this.runner("gh", [
        "issue",
        "pin",
        String(number),
        "--repo",
        `github.com/${this.repo}`,
      ]);
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
    if (cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);
    let raw;
    try {
      raw = await this.runner("gh", args);
    } catch (e) {
      const error = failure(e);
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
      throw new GitHubError(0);
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
  async verify(expected = {}) {
    const user = await this.request("GET", "/user");
    const repo = await this.api("GET");
    if (!repo.has_issues || repo.archived || !repo.permissions?.push)
      throw new Error(
        "Patchwork needs an unarchived repository with Issues enabled and repository write access.",
      );
    if (expected.repoId && expected.repoId !== repo.id)
      throw new Error("Repository identity changed. Reconnect explicitly.");
    if (expected.ownerId && expected.ownerId !== user.id)
      throw new Error(
        "GitHub account changed. Switch back to the account used for this connection.",
      );
    return { user, repo };
  }
}
