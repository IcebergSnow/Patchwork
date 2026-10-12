import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile } from "node:fs/promises";
import { delay, redact } from "./common.mjs";

// One foreground stdio app-server per independent environment. This is the real
// Codex engine, not a hosted service or a substitute hook dispatcher.
export class Codex {
  constructor({ command, args, cwd, env, log, agent, runId, condition = "preflight", setupOnly = false, onEvent = () => {}, onRequest }) {
    this.setupOnly = setupOnly;
    this.events = [];
    this.pending = new Map();
    this.nextId = 0;
    this.logWrites = Promise.resolve();
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    const record = (method, params) => {
      const event = { timestamp: new Date().toISOString(), runId, condition, agent, method, params };
      this.events.push(event);
      // Allowlisted protocol events only. Never persist auth/config responses,
      // raw model requests, or process environment.
      this.logWrites = this.logWrites.then(() => appendFile(log, redact(event) + "\n", { mode: 0o600 }));
      onEvent(event);
    };
    this.record = record;
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
          if (!setupOnly && onRequest && method === "item/tool/requestUserInput") {
            Promise.resolve(onRequest(params)).then(result => this.send({ id: message.id, result }),
              () => this.send({ id: message.id, error: { code: -32603, message: "Scripted response unavailable." } }));
            return;
          }
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
    if(this.exit||this.stopping)return Promise.reject(new Error("Codex process is stopped."));
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
    return this.stopping ||= Promise.resolve().then(async () => {
      this.record("runner/stop", {});
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
    });
  }
}

export function toolResult(event) {
  try { return JSON.parse(event?.params?.item?.result?.content?.find(c => c.type === "text")?.text); }
  catch { return null; }
}
