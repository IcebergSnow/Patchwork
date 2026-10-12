import { writeFile } from "node:fs/promises";
import path from "node:path";
import { newRun, save } from "./common.mjs";
import { prepareRuntime, prepareAgent, configureMcpEnvironment, loadCredentials, chatState } from "./environment.mjs";
import { agentAuthentication, codexAuthentication, AUTH_CONFIG } from "./auth.mjs";
import { Codex } from "./codex.mjs";
import { hookConfiguration, serverConfiguration } from "../../../packages/cli/lib/connections.js";
import { mergeCodex } from "../../../packages/cli/lib/config.js";
import { cleanup } from "./preflight.mjs";

// No prompts, GitHub requests, hook dispatch, or real GH credential. Codex's
// read-only account check needs network access for workspace routing discovery.
export async function localCheck(options) {
  const run = await newRun({ ...options, repo: "local/config-check" });
  const m = run.manifest, clients = [];
  let interrupted = false;
  const stop = () => { interrupted = true; for (const c of clients) void c.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  m.kind = "local-check";
  m.evidence = {};
  try {
    const credentials = await loadCredentials({ local: true });
    m.authentication = { source: "chatgpt", verified: true };
    const shared = await prepareRuntime(run);
    for (const id of ["receiver", "sender"]) {
      const a = await prepareAgent(run, id, shared, credentials);
      a.connection = path.join(a.base, "patchwork/connections/local.json");
      await save(a.connection, { enabled: false }); // cannot register, even if a hook runs unexpectedly
      await save(a.hooks, hookConfiguration(shared.entry, a.connection));
      await writeFile(path.join(a.work, ".codex/config.toml"), mergeCodex("", serverConfiguration(shared.entry, a.connection)));
      await configureMcpEnvironment(a);
      await agentAuthentication(a, credentials.codex);
      if (interrupted) throw new Error("Local check interrupted.");
      const c = new Codex({ command: "/usr/bin/sandbox-exec", args: ["-f", a.profile, options.codex || "codex", "-c", `projects.${JSON.stringify(a.work)}.trust_level="trusted"`, "app-server", "--stdio"], cwd: a.work, env: a.env,
        log: path.join(run.dir, `${id}.jsonl`), agent: id, runId: m.runId, setupOnly: true });
      clients.push(c);
      const saved = m.agents.find(v => v.id === id);
      saved.pid = c.child.pid;
      await run.persist();
      await c.initialize();
      saved.authentication = await codexAuthentication(c, a);
      let cursor, model;
      do {
        const catalog = await c.call("model/list", { limit: 100, ...(cursor && { cursor }) });
        model ||= catalog.data.find(v => v.model === m.model || v.id === m.model);
        cursor = catalog.nextCursor;
      } while (cursor && !model);
      m.evidence[`${id}ExactModelAvailable`] = !!model?.supportedReasoningEfforts?.some(e => e.reasoningEffort === m.reasoning);
      const hooks = (await c.call("hooks/list", { cwds: [a.work] })).data.flatMap(v => v.hooks);
      m.evidence[`${id}HookConfiguration`] = hooks.length === 3 && hooks.every(h => h.sourcePath === a.hooks && h.enabled);
      const result = await c.call("thread/start", { cwd: a.work, model: m.model, modelProvider: "openai", approvalPolicy: "never", sandbox: "danger-full-access", allowProviderModelFallback: false, config: AUTH_CONFIG });
      saved.threadId = result.thread.id;
      if (result.thread.modelProvider !== "openai") throw new Error("Unexpected provider in local check.");
      const servers = await c.call("mcpServerStatus/list", { threadId: saved.threadId, serverName: "patchwork" });
      const tools = servers.data.find(s => s.name === "patchwork")?.tools || {};
      m.evidence[`${id}McpConfiguration`] = ["check_board", "post_message", "acknowledge_request"].every(t => t in tools);
      m.evidence[`${id}NoChatRegistered`] = (await chatState(a)).length === 0;
      m.evidence[`${id}NoModelTurn`] = !c.events.some(e => ["turn/started", "thread/tokenUsage/updated"].includes(e.method));
      saved.status = "checked without model turn";
    }
    m.evidence.independentSessions = new Set(m.agents.map(a => a.threadId)).size === 2;
    m.evidence.independentHomes = new Set(m.agents.map(a => a.codex)).size === 2;
    if (interrupted) throw new Error("Local check interrupted.");
    m.status = Object.values(m.evidence).every(Boolean) ? "PASS" : "FAIL";
  } catch (e) { m.status = "FAIL"; m.blocker = e.message; }
  finally {
    await cleanup(run, clients);
    if (!m.cleanup.complete) m.status = "FAIL";
    m.phase0Complete = false;
    m.finishedAt = new Date().toISOString();
    await run.persist();
    await writeFile(path.join(run.dir, "local-check.md"), `# Local configuration check\n\n${m.status}\n\n${m.blocker || "Both native Codex processes reported ChatGPT authentication. No model turn or GitHub call was made."}\n\n${Object.entries(m.evidence).map(([k,v]) => `- ${k}: ${v ? "PASS" : "FAIL"}`).join("\n")}\n\nCleanup: ${m.cleanup.complete ? "complete" : "incomplete"}. Live registration, request delivery, and acknowledgment remain unverified.\n`);
    console.log(`${m.status}: ${path.join(run.dir, "local-check.md")}`);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return run;
}
