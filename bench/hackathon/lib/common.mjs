import { spawn } from "node:child_process";
import { mkdir, readFile, open, rename, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const root = path.resolve(import.meta.dirname, "../../..");
export const defaultOutput = path.join(root, "bench/hackathon/runs");
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
}
export function command(program, args, { cwd, env = process.env, input, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(program, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (b) => { if (stdout.length < 8_000_000) stdout += b; else p.kill("SIGKILL"); });
    p.stderr.on("data", (b) => { if (stderr.length < 32_000) stderr += b; });
    p.stdin.on("error", () => {});
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`${path.basename(program)} exited ${code}: ${redact(stderr).slice(-3000)}`), { code }));
    });
    p.stdin.end(input);
  });
}
const secrets = new Set();
export function secret(value) { if (value) secrets.add(value); return value; }
export function redact(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of secrets) text = text.replaceAll(s, "[REDACTED]");
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(chat_key["\\\s:]+)([a-f0-9-]{36})/gi, "$1[PRIVATE_CHAT_KEY]")
    .replace(/(private chat_key for board tools: )[a-f0-9-]{36}/gi, "$1[PRIVATE_CHAT_KEY]");
}
export function repoName(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || repo.split("/").some((v) => [".", ".."].includes(v)))
    throw new Error("Explicit --repo OWNER/DEDICATED_TEST_REPO is required.");
  return repo;
}
export function runId(value) {
  if (!/^sim-[\dTZ-]+-[a-f0-9]{8}$/.test(value || "")) throw new Error("Invalid simulation run ID.");
  return value;
}
export function authorize(options) {
  if (!options["allow-live"] || !options["sandbox-repo"])
    throw new Error("Live preflight requires --allow-live and --sandbox-repo: authorize model usage and attest this is a dedicated test repository.");
}
export async function ownedDirectory(dir, id) {
  if ((await lstat(dir)).isSymbolicLink() || (await realpath(dir)) !== path.resolve(dir))
    throw new Error("Refusing a linked simulation directory.");
  if ((await json(path.join(dir, ".patchwork-sim-owner.json"))).runId !== id)
    throw new Error("Simulation ownership marker mismatch; refusing removal.");
}
export async function newRun(options) {
  const seconds = Number(options.seconds || 300), tokens = Number(options.tokens || 250_000);
  const maximum=options.kind === 'comparison' ? 1800 : 300;
  if (!(Number.isInteger(seconds) && seconds >= 30 && seconds <= maximum)) throw new Error(`Phase ${options.kind==='comparison'?'1':'0'} supports a total 30–${maximum} second live session budget.`);
  if (!Number.isSafeInteger(tokens) || tokens < 1000) throw new Error("--tokens must be an integer of at least 1000.");
  const id = `sim-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = path.resolve(options.output || defaultOutput);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await realpath(output)) !== output) throw new Error("Output must be a canonical, unlinked directory.");
  const dir = path.join(output, id);
  await mkdir(dir, { mode: 0o700 });
  await save(path.join(dir, ".patchwork-sim-owner.json"), { runId: id });
  const manifest = { version: 1, runId: id, kind: options.kind || "preflight", createdAt: new Date().toISOString(), status: "INCONCLUSIVE", repo: options.repo,
    model: options.model || "gpt-6-luna", reasoning: options.reasoning || "low", runtimeSeconds: seconds, tokenBudget: tokens,
    agents: [], resources: [], cleanup: { complete: false, errors: [] }, evidence: {}, limitations: [
      "Same GitHub account for both agents; separate chat identities and local state.",
      "Process-based macOS isolation is used for Phase 0; this is not a hackathon comparison.",
      "No cost estimate without authoritative pricing/accounting; no fabricated token counts.",
      "Token limit uses reported aggregate usage, including cached input; an in-flight model call can overshoot it.",
    ] };
  await save(path.join(dir, "manifest.json"), manifest);
  return { dir, manifest, persist: () => save(path.join(dir, "manifest.json"), manifest) };
}
