import { randomUUID } from "node:crypto";
import { CHECK_INTERVAL } from "../../../packages/cli/lib/runtime.js";
import { PROMPT_INTERVAL } from "../../../packages/cli/lib/sync.js";
import { codexAuthentication } from "./auth.mjs";
import { toolResult } from "./codex.mjs";
import { delay } from "./common.mjs";

// Read production intervals; never change them for a test. The sender's extra
// margin lets B finish its acknowledgment before A's single checkpoint ends.
export const checkpointSeconds = Math.ceil(CHECK_INTERVAL / 1000) + 5;
export const returnSeconds = checkpointSeconds + 30;
const fields = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens"];
const zero = () => Object.fromEntries(fields.map(k => [k, 0]));
export function usage(events) {
  const previous = new Map(), increments = [];
  for (const e of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (e.method !== "thread/tokenUsage/updated") continue;
    const value = e.params?.tokenUsage?.total, before = previous.get(e.agent) || zero();
    if (!fields.every(k => Number.isSafeInteger(value?.[k]) && value[k] >= before[k])) {
      increments.push({ agent: e.agent, turnId: e.params?.turnId, at: e.timestamp, delta: null });
      continue;
    }
    increments.push({ agent: e.agent, turnId: e.params.turnId, at: e.timestamp,
      delta: Object.fromEntries(fields.map(k => [k, value[k] - before[k]])) });
    previous.set(e.agent, value);
  }
  const totals = zero();
  for (const v of previous.values()) for (const k of fields) totals[k] += v[k];
  return { totals, missingAgents: ["receiver", "sender"].filter(a => !previous.has(a)), increments };
}
const after = (a, b) => !!a && !!b && Date.parse(a.timestamp) >= Date.parse(b.timestamp);
const turn = e => e.params?.turnId;
const item = e => e.params?.item;
const shell = e => (item(e)?.command || "").trim().replace(/^\/bin\/(?:zsh|bash) -l?c ['"]([^'"]+)['"]$/, "$1");
const native = (events, agent, name, paths, turnId) => events.filter(e => e.agent === agent && e.method === "hook/completed" &&
  e.params?.run?.eventName === name && e.params.run.status === "completed" && e.params.run.sourcePath === paths[agent] &&
  e.params.run.handlerType === (name === "sessionStart" ? "command" : "mcpTool") && (!turnId || turn(e) === turnId));
const call = (events, agent, name, turnId) => events.filter(e => e.agent === agent && e.method === "item/completed" &&
  item(e)?.type === "mcpToolCall" && item(e).server === "patchwork" && item(e).tool === name &&
  item(e).status === "completed" && !item(e).error && !item(e).result?.isError && turnId && turn(e) === turnId);
function contextRecords(e) {
  return (e.params.run.entries || []).filter(v => v.kind === "context").flatMap(v => v.text.split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === "object" ? [value] : []; } catch { return []; }
  }));
}
function observed(e, extra = {}) {
  return e ? { agent: e.agent, at: e.timestamp, turnId: turn(e),
    ...(e.params.run ? { hookId: e.params.run.id, hook: e.params.run.eventName, source: e.params.run.sourcePath } :
      { itemId: item(e).id, tool: item(e).tool }), ...extra } : null;
}
export function pathEvidence(events, p, paths, name) {
  const eventName = name === "prompt" ? "userPromptSubmit" : "postToolUse";
  const began = e => e && events.find(v => v.agent === e.agent && v.method === "item/started" && item(v)?.id === item(e).id) || e;
  const request = call(events, "sender", "post_message", p.postTurn).find(e => item(e).arguments?.kind === "request" && item(e).arguments.body === p.marker);
  const number = toolResult(request)?.number, messageId = toolResult(request)?.id;
  const delivery = Number.isSafeInteger(number) && p.receiveTurn && native(events, "receiver", eventName, paths, p.receiveTurn).find(e =>
    contextRecords(e).some(r => r.id === `issue:${number}` && typeof r.body === "string" && r.body.includes(p.marker)) && after(e, began(request)));
  const ack = call(events, "receiver", "acknowledge_request", p.receiveTurn).find(e => Number.isSafeInteger(number) &&
    item(e).arguments?.request_id === number && item(e).arguments.response === "can_handle" && Number.isSafeInteger(toolResult(e)?.id) && after(began(e), delivery));
  const ackId = toolResult(ack)?.id;
  const returned = Number.isSafeInteger(ackId) && p.returnTurn && native(events, "sender", eventName, paths, p.returnTurn).find(e =>
    contextRecords(e).some(r => r.id === `comment:${ackId}` && r.thread === number && typeof r.body === "string" && r.body.includes("Can handle")) && after(e, began(ack)));
  function checkpoint(e, agent, write, seconds) {
    if (!e || !write) return false;
    const command = events.find(v => v.agent === agent && v.method === "item/completed" && turn(v) === turn(e) &&
      item(v)?.type === "commandExecution" && item(v).status === "completed" && item(v).exitCode === 0 &&
      shell(v) === `sleep ${seconds}` && e.params.run.id?.endsWith(`:${item(v).id}`) && after(e, v));
    // Same receiving turn, genuine completed shell command, no prompt between
    // the peer's write and the hook. A later prompt can never rescue this path.
    return !!command && !events.some(v => v.agent === agent &&
      ((v.method === "hook/started" && v.params.run?.eventName === "userPromptSubmit") ||
       (v.method === "item/started" && item(v)?.type === "userMessage")) && after(v, began(write)) && after(e, v));
  }
  const checks = {
    request: !!request && Number.isSafeInteger(number) && Number.isSafeInteger(messageId),
    requestDelivery: !!delivery,
    acknowledgment: !!ack,
    acknowledgmentDelivery: !!returned,
    path: name === "prompt" ? !!delivery && !!returned && p.postTurn !== p.returnTurn &&
      native(events, "receiver", "sessionStart", paths).some(e => turn(e) !== p.receiveTurn && after(delivery, e)) :
      checkpoint(delivery, "receiver", request, checkpointSeconds) && checkpoint(returned, "sender", ack, returnSeconds),
  };
  return { checks, status: Object.values(checks).every(Boolean) ? "PASS" : p.finished ? "FAIL" : "NOT VERIFIED",
    requestNumber: number ?? null, messageId: messageId ?? null, acknowledgmentId: ackId ?? null,
    steps: { request: observed(request, { messageId, requestNumber: number }), requestDelivery: observed(delivery),
      acknowledgment: observed(ack, { acknowledgmentId: ackId }), acknowledgmentDelivery: observed(returned) } };
}
export function evidence(events, phases, paths) {
  const delivery = Object.fromEntries(["prompt", "checkpoint"].map(name => [name, pathEvidence(events, phases?.[name] || {}, paths, name)]));
  const commands = events.filter(e => e.method === "item/started" && item(e)?.type === "commandExecution");
  const allowed = e => e.agent === "receiver" ? turn(e) === phases?.checkpoint?.receiveTurn && shell(e) === `sleep ${checkpointSeconds}` :
    e.agent === "sender" && turn(e) === phases?.checkpoint?.postTurn && shell(e) === `sleep ${returnSeconds}`;
  const checks = {
    startupReceiver: native(events, "receiver", "sessionStart", paths).some(e => e.params.run.entries.some(v => v.kind === "context" && v.text.includes("Your agent ID:"))),
    startupSender: native(events, "sender", "sessionStart", paths).some(e => e.params.run.entries.some(v => v.kind === "context" && v.text.includes("Your agent ID:"))),
    promptRoundTrip: delivery.prompt.status === "PASS",
    checkpointRoundTrip: delivery.checkpoint.status === "PASS",
    noManualBoardReads: !events.some(e => item(e)?.type === "mcpToolCall" && !["post_message", "acknowledge_request"].includes(item(e).tool)),
    onlyTwoCheckpointCommands: commands.every(allowed) && ["receiver", "sender"].every(a => new Set(commands.filter(e => e.agent === a).map(e => item(e).id)).size <= 1),
    modelUnchanged: !events.some(e => e.method === "model/rerouted"),
    subscriptionUnchanged: !events.some(e => e.method === "account/updated" && !e.params.subscriptionVerified),
  };
  return { checks, delivery };
}

// Six bounded user turns, not a polling agent. Idle waits here do not call the
// model, hooks, MCP, or GitHub. Only real Codex turns can produce board traffic.
export async function stagedTurns(run, agents, deadline, check, { now = Date.now, wait = delay, authenticate = codexAuthentication } = {}) {
  const m = run.manifest, receiver = agents.find(a => a.id === "receiver"), sender = agents.find(a => a.id === "sender");
  m.phases = Object.fromEntries(["prompt", "checkpoint"].map(name => [name, { marker: `${m.runId} ${name} REQUEST-${randomUUID()}` }]));
  m.stages = [];
  const events = () => agents.flatMap(a => a.client.events);
  const paths = Object.fromEntries(agents.map(a => [a.id, a.hooks]));
  const refresh = () => { const proof = evidence(events(), m.phases, paths); m.evidence = proof.checks; m.delivery = proof.delivery; };
  const guard = () => { check(); if (now() >= deadline) throw new Error("Authorized live runtime budget reached."); };
  const until = async predicate => { for (;;) { guard(); if (predicate()) return; await wait(200); } };
  const base = `Authorized native-hook test ${m.runId}. Only this run's board content. Use your own hook-provided chat_key. Never read credentials, files, board tools check_board/read_messages, or GitHub directly; never invoke hooks. No edits or resolutions. No commentary; finish in one sentence. `;
  async function start(a, id, prompt) {
    guard(); await authenticate(a.client, a); guard();
    const s = { id, agent: a.id, startedAt: new Date(now()).toISOString(), status: "started" };
    m.stages.push(s); await run.persist();
    const result = await a.client.call("turn/start", { threadId: a.threadId, model: m.model, effort: m.reasoning,
      input: [{ type: "text", text: base + prompt }] }, Math.max(1, Math.min(75000, deadline - now())));
    s.turnId = result.turn.id; await run.persist(); return s;
  }
  async function finish(a, s) {
    await until(() => a.client.events.some(e => e.method === "turn/completed" && e.params.turn.id === s.turnId));
    const done = a.client.events.find(e => e.method === "turn/completed" && e.params.turn.id === s.turnId);
    s.status = done.params.turn.status; s.finishedAt = done.timestamp; refresh(); await run.persist();
    if (s.status !== "completed") throw new Error(`${s.id}: Codex turn ${s.status}.`);
  }
  async function quiet(a) {
    // Wait out the normal shared prompt cache, without changing it or reading
    // private cursors to force delivery. Include command/MCP completion times.
    const last = a.client.events.filter(e => ["hook/completed", "item/completed"].includes(e.method)).at(-1);
    const due = Date.parse(last?.timestamp || new Date(now()).toISOString()) + PROMPT_INTERVAL + 1000;
    await until(() => now() >= due);
  }
  function requirePath(name) {
    m.phases[name].finished = true; refresh();
    if (m.delivery[name].status !== "PASS") throw Object.assign(new Error(`${name} round trip finished without all required native delivery evidence.`), { trialFailure: true });
  }
  function requireSteps(name, ...steps) {
    refresh();
    if (steps.some(key => !m.delivery[name].checks[key])) {
      m.phases[name].finished = true;
      throw Object.assign(new Error(`${name}: required ${steps.join("/")} evidence missing; no further model turn will be started.`), { trialFailure: true });
    }
  }
  const post = name => `Post exactly one MCP post_message request, title '${m.runId} ${name} native test', body exactly '${m.phases[name].marker}'. `;
  const acknowledge = "Acknowledge only the new request delivered by this turn's native hook with MCP acknowledge_request can_handle, once. No request in native context means report NOT RECEIVED and finish; never poll or invent an ID. ";
  const sleep = seconds => `Run exactly one exec_command 'sleep ${seconds}' with yield_time_ms=1000. If still running, use one write_stdin with empty input and yield_time_ms=120000 to await that process; do not start more commands or a polling loop. `;

  await finish(receiver, await start(receiver, "register-receiver", "Let native startup introduce you. No tools; reply READY."));
  if (!m.evidence.startupReceiver) throw Object.assign(new Error("Receiver native SessionStart was not verified."), { trialFailure: true });
  let s = await start(sender, "prompt-request", post("prompt") + "Then finish without waiting or shell commands.");
  m.phases.prompt.postTurn = s.turnId; await finish(sender, s);
  requireSteps("prompt", "request");
  await quiet(receiver);
  s = await start(receiver, "prompt-acknowledgment", acknowledge);
  m.phases.prompt.receiveTurn = s.turnId; await finish(receiver, s);
  requireSteps("prompt", "requestDelivery", "acknowledgment");
  await quiet(sender);
  s = await start(sender, "prompt-receipt", "Confirm the receiver's Can handle acknowledgment only if supplied by this prompt's native hook. No tools.");
  m.phases.prompt.returnTurn = s.turnId; await finish(sender, s);
  requirePath("prompt"); await run.persist();
  console.log("UserPromptSubmit round trip verified. Starting separate PostToolUse round trip.");

  const b = await start(receiver, "checkpoint-acknowledgment", sleep(checkpointSeconds) + "After that checkpoint, " + acknowledge + "Ignore the earlier request already acknowledged.");
  m.phases.checkpoint.receiveTurn = b.turnId; await run.persist();
  await until(() => {
    if (receiver.client.events.some(e => e.method === "turn/completed" && e.params.turn.id === b.turnId))
      throw Object.assign(new Error("Receiver finished before starting its checkpoint command."), { trialFailure: true });
    return receiver.client.events.some(e => e.method === "item/started" && turn(e) === b.turnId && item(e)?.type === "commandExecution" && shell(e) === `sleep ${checkpointSeconds}`);
  });
  const a = await start(sender, "checkpoint-request-and-receipt", post("checkpoint") + sleep(returnSeconds) +
    "Confirm the receiver's Can handle acknowledgment only if delivered by a native tool hook; otherwise report NOT RECEIVED. Then finish. No other tools.");
  m.phases.checkpoint.postTurn = m.phases.checkpoint.returnTurn = a.turnId; await run.persist();
  await finish(receiver, b);
  requireSteps("checkpoint", "request", "requestDelivery", "acknowledgment");
  await finish(sender, a);
  requirePath("checkpoint"); await run.persist();
}
