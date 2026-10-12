import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { authorize, command, delay, json, newRun, ownedDirectory, redact, repoName, root, save } from "./common.mjs";
import { prepareRuntime, prepareAgent, configureMcpEnvironment, loadCredentials, chatState } from "./environment.mjs";
import { Codex } from "./codex.mjs";
import { stagedTurns, evidence, usage } from "./stages.mjs";
import { agentAuthentication, codexAuthentication, AUTH_CONFIG } from "./auth.mjs";
import { report } from "./report.mjs";
import { metadata } from "../../../packages/cli/lib/board.js";

const ENTRY = path.join(root, "packages/cli/bin/patchwork.js");
export function ownedRequest(issue, manifest, chats) {
  const data = metadata(issue.body);
  return !issue.pull_request && !manifest.initialIssueIds?.includes(issue.id) &&
    issue.user?.id === manifest.repository.userId && data?.owner_id === manifest.repository.userId &&
    data?.type === "request" && chats.has(data.agent_id) &&
    issue.body.includes(manifest.runId) && issue.title.includes(manifest.runId);
}
export async function github(repo, endpoint, { env = process.env, method = "GET", input } = {}) {
  const args = ["api", "--hostname", "github.com", "--method", method, endpoint.startsWith("/") ? endpoint : `/repos/${repo}${endpoint ? `/${endpoint}` : ""}`];
  if (input) args.push("--input", "-");
  const text = await command("gh", args, { env, input: input && JSON.stringify(input) });
  return text.trim() ? JSON.parse(text) : null;
}
async function list(repo, endpoint, env) {
  const result = [];
  for (let page = 1; ; page++) {
    const batch = await github(repo, `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { env });
    result.push(...batch);
    if (batch.length < 100) return result;
  }
}
export async function cleanupRequests(run, owned, api = { list, github }) {
  const m = run.manifest;
  const requests = (await api.list(m.repo, "issues?state=all")).filter(i => ownedRequest(i, m, owned));
  m.resources.push(...requests.filter(i => !m.resources.some(r => r.type === "request" && r.id === i.id))
    .map(i => ({ type: "request", id: i.id, number: i.number, url: i.html_url })));
  await run.persist(); // recover uncertain writes before doing any cleanup
  m.closedRequests = [];
  for (const issue of requests) {
    const replies = await api.list(m.repo, `issues/${issue.number}/comments`);
    await save(path.join(run.dir, `request-${issue.number}.json`), JSON.parse(redact({ issue, comments: replies })));
    if (issue.state !== "closed") await api.github(m.repo, `issues/${issue.number}`, { method: "PATCH", input: { state: "closed" } });
    if ((await api.github(m.repo, `issues/${issue.number}`)).state !== "closed") throw new Error("Run request is still open after cleanup.");
    m.closedRequests.push(issue.number);
    await run.persist();
  }
}
export async function validateRepo(repo, env) {
  repoName(repo);
  const pkg = await json(path.join(root, "packages/cli/package.json"));
  const source = pkg.repository.url.match(/github\.com\/([^/]+\/[^/]+?)\.git$/)?.[1];
  if (!source || source.toLowerCase() === repo.toLowerCase()) throw new Error("Refusing the Patchwork source repository.");
  const [remote, production, user] = await Promise.all([
    github(repo, "", { env }), github(source, "", { env }), github(repo, "/user", { env }),
  ]);
  if (remote.id === production.id) throw new Error("Refusing the Patchwork source repository ID.");
  if (remote.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error("Repository renamed or redirected; supply its canonical name.");
  if (!remote.permissions?.push || !remote.has_issues || remote.archived || remote.disabled)
    throw new Error("A writable, active test repository with Issues enabled is required.");
  if (!(remote.owner.id === user.id || remote.permissions?.admin)) throw new Error("Use a test repository you own or administer.");
  return { id: remote.id, fullName: remote.full_name, ownerId: remote.owner.id, userId: user.id, login: user.login };
}
async function installed(agent) {
  const files = (await readdir(path.join(agent.base, "patchwork/connections"))).filter((n) => n.endsWith(".json") && !n.includes(".sessions."));
  if (files.length !== 1) throw new Error("Expected exactly one isolated Patchwork connection.");
  return path.join(agent.base, "patchwork/connections", files[0]);
}
async function until(predicate, deadline, message) {
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(300);
  }
  throw new Error(message);
}
async function collect(run, agents) {
  for (const agent of agents) {
    const saved = run.manifest.agents.find((a) => a.id === agent.id);
    const chats = await chatState(agent);
    saved.chatIds = chats.map((c) => c.id);
    saved.cursors = chats.map((c) => ({ id: c.id, initialized: c.initialized, lastCheck: c.lastCheck, seen: c.seen, registered: c.registered, lastError: c.lastError }));
    saved.usage = agent.client?.events.filter((e) => e.method === "thread/tokenUsage/updated").at(-1)?.params?.tokenUsage?.total || null;
    if (agent.client?.exit) saved.exit = agent.client.exit;
    const cacheDir = path.join(agent.base, "patchwork/github");
    try {
      saved.apiStats = [];
      for (const name of await readdir(cacheDir)) if (name.endsWith(".json")) {
        const cache = await json(path.join(cacheDir, name));
        if (cache.stats) saved.apiStats.push(cache.stats);
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  await run.persist();
}
export async function cleanup(run, clients = [], { retainTemporary = false } = {}) {
  const m = run.manifest;
  m.cleanup = { complete: false, errors: [] };
  await run.persist();
  const attempt = async (fn) => { try { await fn(); } catch (e) { m.cleanup.errors.push(redact(e.message)); } };
  for (const c of clients) await attempt(() => c.stop());
  // On recovery, never signal a reused PID. The recorded command must still
  // contain this agent's unique project path before its process group is killed.
  for (const a of m.agents) if (a.pid && !clients.some((c) => c.child.pid === a.pid)) await attempt(async () => {
    let ps;
    try { ps = await command("ps", ["-p", String(a.pid), "-o", "command="]); } catch (e) { if (e.code === 1) return; throw e; }
    if (!ps.includes(a.work)) throw new Error(`PID ${a.pid} no longer proves run ownership; not signalled.`);
    try { process.kill(-a.pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    await delay(1000);
    try { process.kill(-a.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
  });
  if (m.installAttempted && !m.board) await attempt(async () => {
    const issues = await list(m.repo, "issues?state=all");
    const created = issues.filter((i) => !m.initialIssueIds.includes(i.id));
    if (created.length) {
      m.possibleArtifacts = created.map((i) => ({ type: "issue", id: i.id, number: i.number, url: i.html_url }));
      throw new Error("Installation response was interrupted and new issues exist. Ownership is uncertain; inspect possibleArtifacts before retrying cleanup.");
    }
  });
  if (m.repository && m.board) await attempt(async () => {
    const remote = await validateRepo(m.repo);
    if (remote.id !== m.repository.id || remote.userId !== m.repository.userId) throw new Error("Repository/account ID changed; remote cleanup refused.");
    const comments = await list(m.repo, `issues/${m.board}/comments`);
    const owned = new Set(m.agents.flatMap((a) => a.chatIds || []));
    for (const c of comments) {
      const data = metadata(c.body);
      if (data?.type === "agent" && data.owner_id === m.repository.userId && c.user.id === m.repository.userId &&
        m.agents.some((a) => data.name === `${m.runId}/${a.id} / ${data.agent_id?.slice(0, 6)}`)) owned.add(data.agent_id);
    }
    const records = comments.filter((c) => c.body.includes(m.runId) || owned.has(metadata(c.body)?.agent_id));
    m.remoteArtifacts = records.map((c) => ({ type: "comment", id: c.id, url: c.html_url }));
    await save(path.join(run.dir, "github.json"), JSON.parse(redact(records.map((c) => ({ id: c.id, url: c.html_url, createdAt: c.created_at, updatedAt: c.updated_at, body: c.body })))));
    m.resources.push(...m.remoteArtifacts.filter((r) => !m.resources.some((old) => old.type === r.type && old.id === r.id)));
    await run.persist(); // durable ownership before any remote retirement
    // Discover writes whose response was lost, using BOTH run tags and verified
    // author/chat metadata. Never close a request merely mentioning the run.
    await attempt(() => cleanupRequests(run, owned));
    for (const id of owned) await attempt(() => command(process.execPath, [ENTRY, "disconnect", "--repo", m.repo, "--agent", id], { env: { ...process.env, PATCHWORK_HOME: path.join(run.dir, "cleanup-cache") }, timeout: 120_000 }));
    const status = JSON.parse(await command(process.execPath, [ENTRY, "status", "--repo", m.repo], { env: { ...process.env, PATCHWORK_HOME: path.join(run.dir, "cleanup-cache") }, timeout: 120_000 }));
    // Inspect the public roster using production status; never invent retirement.
    const activeOwned = status.agents.some((a) => owned.has(a.agent_id) && a.active);
    if (activeOwned) throw new Error("Run chat is still active after retirement.");
    m.retiredChatIds = [...owned];
    const after = await list(m.repo, `issues/${m.board}/comments`);
    m.remoteArtifacts = [...after.filter((c) => c.body.includes(m.runId) || owned.has(metadata(c.body)?.agent_id)).map((c) => ({ type: "comment", id: c.id, url: c.html_url })), ...m.resources.filter(r => r.type === "request")];
    m.resources.push(...m.remoteArtifacts.filter((r) => !m.resources.some((old) => old.type === r.type && old.id === r.id)));
    if (m.createdBoard) {
      if (after.some((c) => !m.remoteArtifacts.some((a) => a.id === c.id))) throw new Error("Created board now has unrelated comments; refusing to close it.");
      await github(m.repo, `issues/${m.board}`, { method: "PATCH", input: { state: "closed" } });
    }
  });
  if (!m.cleanup.errors.length && m.temp && !retainTemporary) await attempt(async () => {
    const exists = await lstat(m.temp).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
    if (exists) { await ownedDirectory(m.temp, m.runId); await rm(m.temp, { recursive: true }); }
  });
  if (!m.cleanup.errors.length) await rm(path.join(run.dir, "cleanup-cache"), { recursive: true, force: true });
  m.cleanup.complete = m.cleanup.errors.length === 0;
  m.cleanup.finishedAt = new Date().toISOString();
  await run.persist();
}
export async function preflight(options) {
  authorize(options);
  repoName(options.repo);
  const run = await newRun(options), m = run.manifest, agents = [], clients = [];
  console.log(`Run ${m.runId}`);
  let deadlineTimer, interrupted = false, resourceStop;
  const stop = () => { interrupted = true; for (const c of clients) void c.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const creds = await loadCredentials();
    m.authentication = { source: "chatgpt", verified: true };
    m.repository = await validateRepo(m.repo);
    m.codexVersion = (await command(options.codex || "codex", ["--version"])).trim();
    const previous = await list(m.repo, "issues?state=all");
    const previousLabels = await list(m.repo, "labels");
    m.initialIssueIds = previous.map((i) => i.id);
    m.initialLabelIds = previousLabels.map((i) => i.id);
    await run.persist();
    const shared = await prepareRuntime(run);
    for (const id of ["receiver", "sender"]) {
      const a = await prepareAgent(run, id, shared, creds);
      agents.push(a);
      // Journal the attempted installation before its first possible GitHub
      // write. An ambiguous response must not be called successful cleanup.
      m.installAttempted = true;
      await run.persist();
      await command(process.execPath, [shared.entry, "connect", "--repo", m.repo, "--client", "codex", "--create-board", "--name", `${m.runId}/${id}`], { cwd: a.work, env: a.env, timeout: 120_000 });
      a.connection = await installed(a);
      const c = await json(a.connection);
      m.board = c.board;
      m.createdBoard = !previous.some((i) => i.number === c.board);
      if (m.createdBoard && !m.resources.some((r) => r.type === "board")) {
        m.resources.push({ type: "board", number: c.board, url: c.boardUrl });
        await run.persist();
        const board = await github(m.repo, `issues/${c.board}`);
        await github(m.repo, `issues/${c.board}`, { method: "PATCH", input: { body: `${board.body}\n\nSimulator preflight: ${m.runId}. Disposable test board.` } });
      }
      Object.assign(m.agents.find((v) => v.id === id), { connection: a.connection });
      m.resources.push({ type: "connection", path: a.connection }, { type: "localBranch", name: `${m.runId}/${id}`, path: a.work });
      await run.persist();
      await configureMcpEnvironment(a);
      console.log(`${id}: isolated environment and real Patchwork installation ready.`);
      if (interrupted) throw new Error("Preflight interrupted during setup.");
    }
    const labels = await list(m.repo, "labels");
    m.resources.push(...labels.filter((l) => !m.initialLabelIds.includes(l.id)).map((l) => ({ type: "label", id: l.id, name: l.name, retained: true })));
    await run.persist();
    // Verify siblings are unreadable, not merely assigned different HOME paths.
    for (const a of agents) {
      const other = agents.find((b) => b.id !== a.id);
      const probe = `try {require('fs').readFileSync(${JSON.stringify(path.join(other.work, "README.md"))});process.exit(2)}catch(e){if(!['EPERM','EACCES'].includes(e.code))process.exit(3)}`;
      await command("/usr/bin/sandbox-exec", ["-f", a.profile, process.execPath, "-e", probe], { cwd: a.work, env: a.env });
    }
    const deadline = Date.now() + m.runtimeSeconds * 1000;
    m.startedAt = new Date().toISOString();
    deadlineTimer = setTimeout(() => { resourceStop = "Authorized live runtime budget reached."; for (const c of clients) void c.stop(); }, m.runtimeSeconds * 1000);
    m.hookInventory = [];
    for (const a of agents) {
      await agentAuthentication(a, creds.codex);
      const args = ["-f", a.profile, options.codex || "codex", "-c", `projects.${JSON.stringify(a.work)}.trust_level="trusted"`, "app-server", "--stdio"];
      a.client = new Codex({ command: "/usr/bin/sandbox-exec", args, cwd: a.work, env: a.env, log: path.join(run.dir, `${a.id}.jsonl`), agent: a.id, runId: m.runId, onEvent: (e) => {
        if (e.method === "thread/tokenUsage/updated") {
          a.tokens = e.params.tokenUsage?.total?.totalTokens;
          if (agents.reduce((n, v) => n + (v.tokens || 0), 0) >= m.tokenBudget) resourceStop = "Reported aggregate token budget reached.";
        }
        if (e.method === "model/rerouted") resourceStop = "Codex reported a model substitution; no silent upgrade is permitted.";
        if (e.method === "account/updated" && !e.params.subscriptionVerified) resourceStop = "Codex subscription authentication changed; stopping.";
        if (resourceStop) for (const c of clients) void c.stop();
      } });
      clients.push(a.client);
      const saved = m.agents.find((v) => v.id === a.id);
      saved.pid = a.client.child.pid;
      await run.persist();
      await a.client.initialize();
      saved.authentication = await codexAuthentication(a.client, a);
      let catalog, cursor, model;
      do {
        catalog = await a.client.call("model/list", { limit: 100, ...(cursor && { cursor }) });
        model ||= catalog.data.find((v) => v.model === m.model || v.id === m.model);
        cursor = catalog.nextCursor;
      } while (cursor && !model);
      if (!model?.supportedReasoningEfforts?.some((e) => e.reasoningEffort === m.reasoning)) throw new Error(`Requested model/effort unavailable: ${m.model}/${m.reasoning}; no fallback allowed.`);
      const hooks = await a.client.call("hooks/list", { cwds: [a.work] });
      const configured = hooks.data.flatMap((entry) => entry.hooks);
      if (configured.length !== 3 || configured.some((h) => h.sourcePath !== a.hooks || !h.enabled) ||
        !configured.some((h) => h.eventName === "sessionStart" && h.handlerType === "command") ||
        !["userPromptSubmit", "postToolUse"].every((event) => configured.some((h) => h.eventName === event && h.server === "patchwork" && h.tool === "check_board")))
        throw new Error("Unexpected hook sources or missing Patchwork hooks; refusing automatic hook trust.");
      m.hookInventory.push({ agent: a.id, hooks });
      await run.persist();
      // The app-server subcommand does not forward the TUI's top-level trust
      // flag. Its per-thread override is handled by the installed Codex engine.
      // Only our freshly installed, inspected hooks are present in this HOME.
      const result = await a.client.call("thread/start", { model: m.model, modelProvider: "openai", cwd: a.work, approvalPolicy: "never", sandbox: "danger-full-access", allowProviderModelFallback: false, config: { ...AUTH_CONFIG, bypass_hook_trust: true } });
      if (result.thread.modelProvider !== "openai") throw new Error("Codex selected an unexpected provider.");
      a.threadId = result.thread.id;
      saved.threadId = a.threadId;
      saved.status = "started";
      await run.persist();
    }
    const paths = Object.fromEntries(agents.map((a) => [a.id, a.hooks]));
    const events = () => clients.flatMap((c) => c.events);
    // A thread/start response alone does not prove hook execution. Observe
    // actual hook/completed notifications, including during the first turn.
    if (options["setup-only"]) {
      m.setupOnly = true;
      await until(() => agents.every((a) => a.client.events.some((e) => e.method === "hook/completed" && e.params.run.eventName === "sessionStart")), Math.min(deadline, Date.now() + 65_000), "No native SessionStart observed during setup-only probe. No model prompt was sent.");
      m.evidence = evidence(events(), {}, paths).checks;
      m.blocker = "Setup-only probe: no model prompts were submitted. Full two-agent message delivery is not yet verified.";
      return run;
    }
    const check = () => {
      if (resourceStop || interrupted) throw new Error(resourceStop || "Preflight interrupted.");
      if (clients.some(c => c.exit)) throw new Error("A Codex process exited before the staged trial completed.");
    };
    await stagedTurns(run, agents, deadline, check);
    await collect(run, agents);
    const chats = await Promise.all(agents.map(chatState));
    m.evidence.independentIdentities = chats.every((c) => c.length === 1 && c[0].registered) && chats[0][0].id !== chats[1][0].id && chats[0][0].chat_key !== chats[1][0].chat_key;
    m.evidence.independentSessions = new Set(agents.map(a => a.threadId)).size === 2;
    m.evidence.independentCursors = agents[0].connection !== agents[1].connection && chats.every((c) => c[0]?.initialized && Object.keys(c[0].seen).length > 0);
    const comments = await list(m.repo, `issues/${m.board}/comments`);
    m.evidence.remoteRegistrations = chats.every(cs => cs.every(chat => comments.some(c => metadata(c.body)?.agent_id === chat.id && metadata(c.body)?.type === "agent")));
    for (const [name, proof] of Object.entries(m.delivery)) {
      const number = proof.requestNumber;
      const request = await github(m.repo, `issues/${number}`);
      const replies = await list(m.repo, `issues/${number}/comments`);
      const ack = replies.find(c => c.id === proof.acknowledgmentId && metadata(c.body)?.type === "ack" &&
        metadata(c.body)?.agent_id === chats[0][0].id && metadata(c.body)?.response === "can_handle");
      m.evidence[`${name}ReceiverCursor`] = !!chats[0]?.[0]?.seen[`issue:${number}`];
      m.evidence[`${name}SenderCursor`] = !!ack && !!chats[1]?.[0]?.seen[`comment:${ack.id}`];
      m.evidence[`${name}RemoteRecords`] = request.id === proof.messageId && ownedRequest(request, m, new Set([chats[1][0].id])) &&
        request.body.includes(m.phases[name].marker) && !!ack && ack.user.id === m.repository.userId;
    }
    m.status = Object.values(m.evidence).every(Boolean) ? "PASS" : "FAIL";
  } catch (e) {
    m.status = e.trialFailure ? "FAIL" : "INCONCLUSIVE";
    m.blocker = redact((resourceStop || e.message) + " " + clients.flatMap((c) => c.events.filter((v) => v.method === "process/stderr").slice(-4).map((v) => v.params.text)).join("").slice(-2500));
    console.error(m.blocker);
  } finally {
    clearTimeout(deadlineTimer);
    for (const c of clients) await c.stop();
    await collect(run, agents).catch((e) => { m.collectionError = redact(e.message); });
    for (const a of m.agents) {
      const client = agents.find((v) => v.id === a.id)?.client;
      a.status = client?.events.filter((e) => e.method === "turn/completed").at(-1)?.params?.turn?.status || "stopped";
    }
    if (m.phases) {
      const events = clients.flatMap(c => c.events);
      const proof = evidence(events, m.phases, Object.fromEntries(agents.map(a => [a.id, a.hooks])));
      Object.assign(m.evidence, proof.checks);
      if (m.status === "PASS" && !Object.values(m.evidence).every(Boolean)) {
        m.status = "FAIL";
        m.blocker = "Final native evidence or safety checks failed; see the per-path report.";
      }
      m.delivery = proof.delivery;
      m.usage = usage(events);
      m.shutdownDiagnostics = events.filter(e => e.method === "process/stderr").map(e => ({
        agent: e.agent, at: e.timestamp, text: e.params.text,
        afterStop: events.some(s => s.agent === e.agent && s.method === "runner/stop" && s.timestamp <= e.timestamp),
      }));
      for (const stage of m.stages) {
        if (stage.status === "started") {
          const ended = events.find(e => e.agent === stage.agent && e.method === "turn/completed" && e.params.turn.id === stage.turnId);
          stage.status = ended?.params.turn.status || "stopped";
          stage.finishedAt = ended?.timestamp || events.find(e => e.agent === stage.agent && e.method === "process/exit")?.timestamp || new Date().toISOString();
        }
        const samples = m.usage.increments.filter(e => e.agent === stage.agent && e.turnId === stage.turnId);
        stage.usage = samples.length && samples.every(e => e.delta) ? samples.reduce((sum, e) => {
          for (const [key, v] of Object.entries(e.delta)) sum[key] = (sum[key] || 0) + v;
          return sum;
        }, {}) : null;
      }
    }
    m.finishedAt = new Date().toISOString();
    await run.persist();
    await cleanup(run, clients);
    m.phase0Complete = m.status === "PASS" && m.cleanup.complete;
    if (m.status === "PASS" && !m.cleanup.complete) { m.status = "INCONCLUSIVE"; m.blocker = "Handshake passed, but cleanup is incomplete."; }
    await run.persist();
    console.log(`${m.status}: ${await report(run)}`);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return run;
}
