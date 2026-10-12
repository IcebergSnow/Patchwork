import path from "node:path";
import os from "node:os";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { command, json, root, save, secret } from "./common.mjs";
import { sourceAuthentication, subscriptionAuth, MCP_ENV, AUTH_CONFIG } from "./auth.mjs";

const quote = (s) => JSON.stringify(s);
export function seatbelt(agent, runtime) {
  return `(version 1)
(allow default)
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath ${quote(root)}))
(allow file-read-metadata)
(allow file-read* (subpath ${quote(runtime)}) (subpath ${quote(agent)}))
(deny file-write*)
(allow file-write* (subpath ${quote(agent)}) (literal "/dev/null") (literal "/dev/tty"))
(deny process-info* (target others))
`;
}
export async function prepareRuntime(run) {
  if (process.platform !== "darwin") throw new Error("The simulator currently requires macOS sandbox-exec. No fallback to unisolated processes.");
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "patchwork-sim-")));
  await save(path.join(temp, ".patchwork-sim-owner.json"), { runId: run.manifest.runId });
  run.manifest.temp = temp;
  run.manifest.resources.push({ type: "localEnvironment", path: temp });
  await run.persist();
  const runtime = path.join(temp, "runtime");
  await mkdir(runtime);
  await cp(path.join(root, "packages/cli"), path.join(runtime, "packages/cli"), { recursive: true, dereference: true });
  await cp(path.join(root, "node_modules"), path.join(runtime, "node_modules"), {
    recursive: true, dereference: true,
    filter: (p) => !p.includes(`${path.sep}@icebergsnow`) && !p.includes(`${path.sep}.bin`),
  });
  return { runtime, entry: path.join(runtime, "packages/cli/bin/patchwork.js") };
}
// Codex forwards a small default environment to stdio MCP servers. The isolated
// gh configuration is intentionally empty, so forward the in-memory credential
// explicitly. Config contains variable names only, never their values.
export function mcpEnvironment(text) {
  const config = parse(text);
  const server = config.mcp_servers?.patchwork;
  if (!server?.command) throw new Error("Install Patchwork before configuring its isolated MCP environment.");
  server.env_vars = MCP_ENV;
  return stringify(config);
}
export async function configureMcpEnvironment(agent) {
  const file = path.join(agent.work, ".codex/config.toml");
  await writeFile(file, mcpEnvironment(await readFile(file, "utf8")), { mode: 0o600 });
}
export function agentEnvironment(base, github) {
  const home = path.join(base, "home"), codex = path.join(home, ".codex");
  return {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: codex,
    GH_CONFIG_DIR: path.join(base, "gh"), GH_TOKEN: github,
    PATCHWORK_HOME: path.join(base, "patchwork"),
    TMPDIR: path.join(base, "tmp") + "/", TMP: path.join(base, "tmp"), TEMP: path.join(base, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1",
  };
}
export async function prepareAgent(run, id, shared, credentials, { seedCommit, comparison = run.manifest.kind === 'comparison' } = {}) {
  subscriptionAuth(credentials.codex);
  const base = path.join(run.manifest.temp, id), work = path.join(base, "project");
  const home = path.join(base, "home"), codex = path.join(home, ".codex");
  for (const d of [work, codex, path.join(base, "tmp"), path.join(base, "gh"), path.join(base, "patchwork")]) await mkdir(d, { recursive: true, mode: 0o700 });
  const env = agentEnvironment(base, credentials.github);
  await writeFile(path.join(codex, "auth.json"), credentials.codex, { mode: 0o600 });
  if (credentials.models) await writeFile(path.join(codex, "models_cache.json"), credentials.models, { mode: 0o600 });
  // Environment filtering keeps the GitHub credential out of model-run shell
  // commands. configureMcpEnvironment separately forwards it to Patchwork's
  // trusted MCP server; the native command hook inherits the parent environment.
  await writeFile(path.join(codex, "config.toml"), `model = ${quote(run.manifest.model)}
model_reasoning_effort = ${quote(run.manifest.reasoning)}
${Object.entries(AUTH_CONFIG).map(([k,v]) => `${k} = ${quote(v)}`).join("\n")}
${comparison?'web_search = "disabled"':''}
[features]
hooks = true
${comparison?'apps = false\nplugins = false\nmulti_agent = false\ncomputer_use = false\nbrowser_use = false\nin_app_browser = false\nimage_generation = false':''}
[shell_environment_policy]
inherit = "all"
exclude = ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]
[projects.${quote(work)}]
trust_level = "trusted"
`, { mode: 0o600 });
  await command("git", ["init", "--initial-branch=main", work], { env });
  await command("git", ["-C", work, "remote", "add", "origin", `https://github.com/${run.manifest.repo}.git`], { env });
  if (seedCommit) {
    await command("git", ["-C", work, "config", "credential.helper", "!gh auth git-credential"], { env });
    await command("git", ["-C", work, "fetch", "--no-tags", "origin", "main"], { env });
    const head=(await command("git", ["-C", work, "rev-parse", "FETCH_HEAD"], { env })).trim();
    if(head!==seedCommit)throw new Error("Starter changed during setup; refusing trial.");
    await command("git", ["-C", work, "reset", "--hard", seedCommit], { env });
    await command("git", ["-C", work, "config", "user.name", `Simulator ${id}`], { env });
    await command("git", ["-C", work, "config", "user.email", `${id}@simulator.invalid`], { env });
  } else {
    await writeFile(path.join(work, "README.md"), "Disposable native hook feasibility worktree. No application code.\n");
    await command("git", ["-C", work, "add", "README.md"], { env });
    await command("git", ["-C", work, "-c", "user.name=Patchwork simulator", "-c", "user.email=simulator@example.invalid", "commit", "-m", "Native hook preflight"], { env });
  }
  await command("git", ["-C", work, "checkout", "-b", `${run.manifest.runId}/${id}`], { env });
  const profile = path.join(base, "isolation.sb");
  await writeFile(profile, seatbelt(base, shared.runtime), { mode: 0o600 });
  const agent = { id, base, work, codex, profile, entry: shared.entry, hooks: path.join(work, ".codex/hooks.json"), status: "prepared" };
  run.manifest.agents.push(agent);
  await run.persist();
  // Positive AND negative controls before credentials/model sessions can run.
  const probe = `const fs=require('fs'); fs.realpathSync(${quote(codex)}); fs.readFileSync(${quote(path.join(work, "README.md"))});
    for (const p of ${JSON.stringify([path.join(root, "package.json"), path.join(run.dir, "manifest.json"), credentials.authPath])}) {
      let denied=false; try {fs.readFileSync(p)} catch(e) {denied=e.code==='EPERM'||e.code==='EACCES'}
      if(!denied) process.exit(2);
    } process.stdout.write('isolated');`;
  const result = await command("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, "-e", probe], { cwd: work, env });
  if (result !== "isolated") throw new Error("Filesystem isolation probe failed.");
  return { ...agent, env };
}
export async function loadCredentials({ local = false } = {}) {
  const source = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const authPath = path.join(source, "auth.json");
  const codex = await sourceAuthentication(source);
  const github = local ? "local-check-no-github-access" : secret((await command("gh", ["auth", "token", "--hostname", "github.com"])).trim());
  if (!github) throw new Error("GitHub authentication is required.");
  const models = await readFile(path.join(source, "models_cache.json"), "utf8").catch((e) => { if (e.code === "ENOENT") return null; throw e; });
  return { github, codex, authPath, models };
}
export async function chatState(agent) {
  if (!agent.connection) return [];
  try { return Object.values((await json(`${agent.connection}.sessions.json`)).chats || {}); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
