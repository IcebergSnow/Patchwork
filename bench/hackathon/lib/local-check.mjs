import { writeFile } from "node:fs/promises";
import path from "node:path";
import { command, newRun, save } from "./common.mjs";
import { prepareRuntime, prepareAgent, configureMcpEnvironment, loadCredentials, chatState } from "./environment.mjs";
import { agentAuthentication, codexAuthentication, AUTH_CONFIG } from "./auth.mjs";
import { Codex } from "./codex.mjs";
import { hookConfiguration, serverConfiguration } from "../../../packages/cli/lib/connections.js";
import { mergeCodex } from "../../../packages/cli/lib/config.js";
import { cleanup } from "./preflight.mjs";
import { roles } from "./scenario.mjs";
import { validHooks, setupNormalGit } from "./trial.mjs";

// No prompts, GitHub requests, hook dispatch, or real GH credential. Codex's
// read-only account check needs network access for workspace routing discovery.
export async function localCheck(options) {
  if(options.phase1&&!['baseline','patchwork'].includes(options.condition))throw new Error('Phase 1 local check needs --condition baseline or patchwork.');
  const run = await newRun({ ...options, repo: "local/config-check" });
  const m = run.manifest, clients = [];
  let interrupted = false;
  const stop = () => { interrupted = true; for (const c of clients) void c.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  m.kind = "local-check";
  const ids=options.phase1?roles:["receiver","sender"];
  const enabled=!options.phase1||options.condition==='patchwork';
  m.condition=options.phase1?options.condition:'preflight';
  m.evidence = {};
  try {
    const credentials = await loadCredentials({ local: true });
    m.authentication = { source: "chatgpt", verified: true };
    const shared = await prepareRuntime(run);
    for (const id of ids) {
      const a = await prepareAgent(run, id, shared, credentials,{comparison:!!options.phase1});
      if(options.phase1){
        const realGh=(await command('/usr/bin/which',['gh'])).trim();
        await setupNormalGit(a,shared,credentials,realGh);
        m.evidence[`${id}InstrumentedShell`]=(await command('/usr/bin/sandbox-exec',['-f',a.profile,'/bin/zsh','-lc','command -v gh'],{cwd:a.work,env:a.env})).trim()===path.join(a.base,'bin/gh');
      }
      if(enabled){
      a.connection = path.join(a.base, "patchwork/connections/local.json");
      await save(a.connection, { enabled: false }); // cannot register, even if a hook runs unexpectedly
      await save(a.hooks, hookConfiguration(shared.entry, a.connection));
      await writeFile(path.join(a.work, ".codex/config.toml"), mergeCodex("", serverConfiguration(shared.entry, a.connection)));
      await configureMcpEnvironment(a);
      }
      await agentAuthentication(a, credentials.codex, {patchwork:enabled});
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
      m.evidence[`${id}HookConfiguration`] = validHooks(hooks,a,enabled);
      const result = await c.call("thread/start", { cwd: a.work, model: m.model, modelProvider: "openai", approvalPolicy: "never", sandbox: "danger-full-access", allowProviderModelFallback: false, config: AUTH_CONFIG });
      saved.threadId = result.thread.id;
      if (result.thread.modelProvider !== "openai") throw new Error("Unexpected provider in local check.");
      const servers = await c.call("mcpServerStatus/list", { threadId: saved.threadId });
      saved.mcpInventory=servers.data.map(s=>({name:s.name,tools:Object.keys(s.tools||{})}));
      const tools = servers.data.find(s => s.name === "patchwork")?.tools || {};
      m.evidence[`${id}McpConfiguration`] = enabled?["check_board", "post_message", "acknowledge_request"].every(t => t in tools)&&(!options.phase1||servers.data.length===1):servers.data.length===0;
      m.evidence[`${id}NoChatRegistered`] = (await chatState(a)).length === 0;
      m.evidence[`${id}NoModelTurn`] = !c.events.some(e => ["turn/started", "thread/tokenUsage/updated"].includes(e.method));
      saved.status = "checked without model turn";
    }
    m.evidence.independentSessions = new Set(m.agents.map(a => a.threadId)).size === ids.length;
    m.evidence.independentHomes = new Set(m.agents.map(a => a.codex)).size === ids.length;
    if (interrupted) throw new Error("Local check interrupted.");
    m.status = Object.values(m.evidence).every(Boolean) ? "PASS" : "FAIL";
  } catch (e) { m.status = "FAIL"; m.blocker = e.message; }
  finally {
    await cleanup(run, clients);
    if (!m.cleanup.complete) m.status = "FAIL";
    m.phase0Complete = false;
    m.finishedAt = new Date().toISOString();
    await run.persist();
    await writeFile(path.join(run.dir, "local-check.md"), `# Local configuration check\n\n${m.status}\n\n${m.blocker || "Native Codex account checks completed without model turns or GitHub calls; see individual results below."}\n\n${Object.entries(m.evidence).map(([k,v]) => `- ${k}: ${v ? "PASS" : "FAIL"}`).join("\n")}\n\nCleanup: ${m.cleanup.complete ? "complete" : "incomplete"}. Live registration, request delivery, and acknowledgment remain unverified.\n`);
    console.log(`${m.status}: ${path.join(run.dir, "local-check.md")}`);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return run;
}
