import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile } from "node:fs/promises";
import { delay, redact } from "./common.mjs";

// One foreground stdio app-server per independent environment. This is the real
// Codex engine, not a hosted service or a substitute hook dispatcher.
export class Codex {
  constructor({ command, args, cwd, env, log, agent, runId, setupOnly = false, onEvent = () => {} }) {
    this.setupOnly = setupOnly;
    this.events = [];
    this.pending = new Map();
    this.nextId = 0;
    this.logWrites = Promise.resolve();
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    const record = (method, params) => {
      const event = { timestamp: new Date().toISOString(), runId, condition: "preflight", agent, method, params };
      this.events.push(event);
      // Allowlisted protocol events only. Never persist auth/config responses,
      // raw model requests, or process environment.
      this.logWrites = this.logWrites.then(() => appendFile(log, redact(event) + "\n", { mode: 0o600 }));
      onEvent(event);
    };
    this.child.stderr.on("data", (b) => record("process/stderr", { text: redact(b.toString()).slice(0, 4000) }));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { record("protocol/invalid", {}); return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(redact(message.error)), { rpcCode: message.error.code }));
        else pending.resolve(message.result);
      } else if (message.method) {
        const { method, params } = message;
        if (method === "account/updated") record(method, { subscriptionVerified: params?.authMode === "chatgpt" });
        if (/^(hook\/(started|completed)|turn\/(started|completed)|thread\/(started|tokenUsage\/updated)|item\/(started|completed)|model\/rerouted|error|warning)$/.test(method))
          record(method, params);
        if (message.id !== undefined) {
          // Preflight never grants arbitrary approvals or supplies fake user
          // messages. Unexpected requests are evidence of an unsupported path.
          record("protocol/unhandledRequest", { method });
          this.send({ id: message.id, error: { code: -32601, message: "Preflight does not support interactive approvals." } });
        }
      }
    });
    this.closed = new Promise((resolve) => {
      const fail = (message) => {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
        this.pending.clear();
      };
      this.child.on("error", (e) => { fail(e.message); resolve(); });
      this.child.on("close", (code, signal) => { this.exit = { code, signal }; record("process/exit", this.exit); fail("Codex process exited."); resolve(); });
    });
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  call(method, params, timeout = 75_000) {
    if (this.setupOnly && !["initialize", "account/read", "config/read", "model/list", "hooks/list", "thread/start", "mcpServerStatus/list"].includes(method))
      return Promise.reject(new Error("Local verification cannot submit model turns, tool calls, or authentication changes."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.call("initialize", { clientInfo: { name: "patchwork_preflight", title: "Patchwork simulator preflight", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized" });
  }
  stop() {
    // A parent can exit before its MCP/shell children. Keep the grace period
    // tied to our process group, not just the parent's close event.
    return this.stopping ||= (async () => {
      const signal = (value) => {
        if (!this.child.pid) return false;
        try { process.kill(-this.child.pid, value); return true; }
        catch (e) { if (e.code === "ESRCH") return false; throw e; }
      };
      if (signal("SIGTERM")) {
        const deadline = Date.now() + 2000;
        while (signal(0) && Date.now() < deadline) await delay(25);
        if (signal(0)) signal("SIGKILL");
      }
      await this.closed;
      await this.logWrites;
    })();
  }
}

export function toolResult(event) {
  try { return JSON.parse(event?.params?.item?.result?.content?.find(c => c.type === "text")?.text); }
  catch { return null; }
}
export function evidence(events, marker, sourcePaths) {
  const by = (agent) => events.filter((e) => e.agent === agent);
  const native = (agent, name) => by(agent).filter((e) => e.method === "hook/completed" && e.params?.run?.eventName === name &&
    e.params.run.status === "completed" && e.params.run.sourcePath === sourcePaths[agent]);
  const calls = (agent, tool) => by(agent).filter(e => e.method === "item/completed" && e.params?.item?.type === "mcpToolCall" &&
    e.params.item.server === "patchwork" && e.params.item.tool === tool && e.params.item.status === "completed" &&
    !e.params.item.error && !e.params.item.result?.isError);
  const request = calls("sender", "post_message").find(e => e.params.item.arguments?.kind === "request" && e.params.item.arguments.body === marker);
  const number = toolResult(request)?.number;
  const contexts = agent => ["sessionStart", "userPromptSubmit", "postToolUse"].flatMap(name => native(agent, name)).filter(e =>
    e.params.run.handlerType === (e.params.run.eventName === "sessionStart" ? "command" : "mcpTool"));
  const delivery = contexts("receiver").find(e => e.params.run.entries.some(v => v.kind === "context" && v.text.includes(marker) &&
    (v.text.includes(`issue:${number}`) || v.text.split("\n").some(line => { try { const r = JSON.parse(line); return r.number === number && r.body?.includes(marker); } catch { return false; } }))));
  const ack = calls("receiver", "acknowledge_request").find(e => Number.isSafeInteger(number) && e.params.item.arguments?.request_id === number && e.params.item.arguments.response === "can_handle");
  const ackId = toolResult(ack)?.id;
  const returned = contexts("sender").find(e => Number.isSafeInteger(ackId) && e.params.run.entries.some(v => v.kind === "context" && v.text.includes(`comment:${ackId}`) && v.text.includes("Can handle")));
  const after = (a,b) => !!a && !!b && Date.parse(a.timestamp) >= Date.parse(b.timestamp);
  const began = call => call?.params.item.id ? by(call.agent).find(e => e.method === "item/started" && e.params?.item?.id === call.params.item.id) || call : call;
  return {
    startupReceiver: native("receiver", "sessionStart").some((e) => e.params.run.handlerType === "command" && e.params.run.entries.some((v) => v.kind === "context" && v.text.includes("Your agent ID:"))),
    startupSender: native("sender", "sessionStart").some((e) => e.params.run.handlerType === "command" && e.params.run.entries.some((v) => v.kind === "context" && v.text.includes("Your agent ID:"))),
    senderMcpRequest: !!request && Number.isSafeInteger(number),
    nativeRequestDelivery: after(delivery, began(request)),
    receiverMcpAcknowledgment: after(began(ack), delivery),
    nativeAcknowledgmentDelivery: after(returned, began(ack)),
    noManualBoardReads: !events.some((e) => e.params?.item?.type === "mcpToolCall" && ["check_board", "read_messages"].includes(e.params.item.tool)),
    onlyCheckpointShellCommands: !events.some(e => e.params?.item?.type === "commandExecution" &&
      !/^sleep\s+20$/.test((e.params.item.command || "").trim().replace(/^\/bin\/(?:zsh|bash) -l?c ['"]([^'"]+)['"]$/, "$1"))),
    modelUnchanged: !events.some((e) => e.method === "model/rerouted"),
    subscriptionUnchanged: !events.some(e => e.method === "account/updated" && !e.params.subscriptionVerified),
  };
}
