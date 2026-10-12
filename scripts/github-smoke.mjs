// Explicit opt-in. This script writes clearly named test artifacts only in the
// sandbox authorized for this project. It never configures your actual project.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  connect,
  disconnect,
  status,
  ENTRY,
} from "../packages/cli/lib/connect.js";
import { run, GitHub } from "../packages/cli/lib/github.js";
import { readJSON } from "../packages/cli/lib/store.js";
import { stateFile } from "../packages/cli/lib/runtime.js";
import { accountFile } from "../packages/cli/lib/sync.js";
import { metadata, marked, visible } from "../packages/cli/lib/board.js";
if (process.env.PATCHWORK_LIVE_REPO !== "IcebergSnow/PatchworkTesting")
  throw new Error(
    "Set PATCHWORK_LIVE_REPO=IcebergSnow/PatchworkTesting to authorize sandbox writes.",
  );
const repo = process.env.PATCHWORK_LIVE_REPO,
  dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "patchwork-live-")),
  ),
  previous = process.env.PATCHWORK_HOME;
process.env.PATCHWORK_HOME = path.join(dir, "state");
const roots = [path.join(dir, "project-a"), path.join(dir, "project-b")],
  clients = [];
const gh = new GitHub(repo);
let request;
async function call(client, name, args) {
  for (let attempt = 0; ; attempt++) {
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120000,
    });
    if (
      attempt === 0 &&
      r.isError &&
      /GitHub request failed \((network\/timeout|5\d\d)\)/.test(
        r.content?.[0]?.text || "",
      )
    ) {
      const connection = await readJSON(clients[0].file);
      const account = await readJSON(accountFile(connection));
      const delay = Math.max(0, (account?.retryAt || 0) - Date.now());
      assert(
        delay <= 60000,
        "Server requires a longer cooldown; retry the test later.",
      );
      console.log(`Retrying ${name} once after the shared GitHub cooldown.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue; // The same arguments recover the runtime's durable operation ID.
    }
    assert(!r.isError, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  }
}
async function startup(file, session) {
  for (let attempt = 0; ; attempt++) {
    const welcome = JSON.parse(
      await run(process.execPath, [ENTRY, "hook", "--connection", file], {
        input: JSON.stringify({
          transcript_path: path.join(dir, "test-transcript.jsonl"),
          session_id: session,
          hook_event_name: "SessionStart",
          prompt: "Do not upload this prompt",
        }),
        timeout: 120000,
      }),
    );
    if (welcome.hookSpecificOutput?.additionalContext.includes("chat_key"))
      return;
    const chat = Object.values(
      (await readJSON(stateFile(file)))?.chats || {},
    )[0];
    const delay = Math.max(0, (chat?.retryAfter || 0) - Date.now());
    if (
      attempt === 0 &&
      chat?.lastError?.includes("GitHub request failed (network/timeout)") &&
      delay <= 60000
    ) {
      console.log(
        "Startup check hit a transient GitHub failure; retrying after its cooldown.",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    assert.fail(
      chat?.lastError || "Startup hook did not deliver this chat's identity.",
    );
  }
}
async function roster() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await status({ repo });
    } catch (error) {
      const delay = Math.max(2000, (error.retryAt || 0) - Date.now());
      if (
        attempt ||
        !(error.status === 0 || error.status >= 500) ||
        delay > 60_000
      )
        throw error;
      console.log(
        "Retrying the read-only roster check after a transient GitHub failure.",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
try {
  for (let i = 0; i < 2; i++) {
    await run("git", ["init", roots[i]]);
    const app = i ? "claude" : "codex";
    const params = {
      cwd: roots[i],
      repo,
      client: app,
      name: `Sandbox smoke / ${app}`,
      create: true,
      claudeFile: path.join(dir, "claude.json"),
      log: () => {},
    };
    const connection = await connect(params);
    await connect(params);
    // Execute the installed native startup hook contract in a separate process.
    await startup(connection.file, `smoke-${i}`);
    const chat = Object.values(
      (await readJSON(stateFile(connection.file))).chats,
    )[0];
    const client = new Client({ name: "patchwork-live-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY, "mcp", "--connection", connection.file],
        stderr: "pipe",
      }),
    );
    clients.push({ client, chat, file: connection.file, app });
  }
  const [a, b] = clients;
  assert.notEqual(a.chat.id, b.chat.id);
  request = await call(a.client, "post_message", {
    chat_key: a.chat.chat_key,
    kind: "request",
    title: "[Patchwork smoke test] Cross-chat acknowledgments",
    body: "Automated sandbox test. No human action needed. This request will be closed by the test.",
  });
  console.log(`Created sandbox request ${request.url}`);
  await call(a.client, "acknowledge_request", {
    chat_key: a.chat.chat_key,
    request_id: request.number,
    response: "cannot_handle",
  });
  let state = await call(b.client, "read_messages", {
    chat_key: b.chat.chat_key,
    open_only: true,
  });
  let r = state.requests.find((r) => r.number === request.number);
  assert.equal(r.needsHumanIntervention, false);
  assert.equal(
    r.acknowledgments.find((x) => x.agent_id === b.chat.id).response,
    null,
  );
  await call(b.client, "acknowledge_request", {
    chat_key: b.chat.chat_key,
    request_id: request.number,
    response: "need_clarification",
  });
  await call(b.client, "post_message", {
    chat_key: b.chat.chat_key,
    replyTo: `issue:${request.number}`,
    body: "Automated reply: clarification does not resolve the request.",
  });
  assert.equal(
    (await gh.api("GET", `/issues/${request.number}`)).state,
    "open",
  );
  await call(b.client, "acknowledge_request", {
    chat_key: b.chat.chat_key,
    request_id: request.number,
    response: "cannot_handle",
  });
  assert(
    (await gh.api("GET", `/issues/${request.number}`)).labels.some(
      (l) => l.name === "patchwork:needs-human",
    ),
  );
  await call(a.client, "acknowledge_request", {
    chat_key: a.chat.chat_key,
    request_id: request.number,
    response: "can_handle",
  });
  assert(
    !(await gh.api("GET", `/issues/${request.number}`)).labels.some(
      (l) => l.name === "patchwork:needs-human",
    ),
  );
  const delivered = await call(b.client, "check_board", {
    transcript_path: path.join(dir, "test-transcript.jsonl"),
    session_id: "smoke-1",
    hook_event_name: "UserPromptSubmit",
  });
  assert(
    delivered.hookSpecificOutput.additionalContext.includes(
      "Cross-chat acknowledgments",
    ),
  );
  // An author edit that changes ONLY the marker must reach the other chat.
  const acknowledgment = (await gh.list(`/issues/${request.number}/comments`))
    .filter(
      (c) =>
        metadata(c.body)?.agent_id === a.chat.id &&
        metadata(c.body)?.type === "ack",
    )
    .at(-1);
  await gh.api("PATCH", `/issues/comments/${acknowledgment.id}`, {
    body: marked(visible(acknowledgment.body), {
      ...metadata(acknowledgment.body),
      response: "need_clarification",
    }),
  });
  // GitHub list endpoints can briefly lag a successful edit. Exercise normal
  // overlapping checkpoints until the edit becomes visible, with a bounded wait.
  for (let attempt = 0; attempt < 6; attempt++) {
    await roster();
    state = await call(b.client, "read_messages", {
      chat_key: b.chat.chat_key,
      open_only: true,
    });
    if (
      state.requests
        .find((r) => r.number === request.number)
        .acknowledgments.find((ack) => ack.agent_id === a.chat.id).response ===
      "need_clarification"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.equal(
    state.requests
      .find((r) => r.number === request.number)
      .acknowledgments.find((ack) => ack.agent_id === a.chat.id).response,
    "need_clarification",
  );
  await call(a.client, "resolve_request", {
    chat_key: a.chat.chat_key,
    request_id: request.number,
  });
  assert.equal(
    (await gh.api("GET", `/issues/${request.number}`)).state,
    "closed",
  );
  await call(a.client, "resolve_request", {
    chat_key: a.chat.chat_key,
    request_id: request.number,
    reopen: true,
  });
  assert.equal(
    (await gh.api("GET", `/issues/${request.number}`)).state,
    "open",
  );
  await call(a.client, "resolve_request", {
    chat_key: a.chat.chat_key,
    request_id: request.number,
  });
  await disconnect({ cwd: roots[0], agent: a.chat.id, log: () => {} });
  const denied = await a.client.callTool({
    name: "post_message",
    arguments: { chat_key: a.chat.chat_key, body: "MUST NOT POST" },
  });
  assert(denied.isError);
  assert.equal((await status({ cwd: roots[0] }))[0].chats[0].enabled, false);
  await disconnect({ repo, agent: b.chat.id, log: () => {} });
  assert.equal(
    (await roster()).agents.find((agent) => agent.agent_id === b.chat.id)
      .active,
    false,
  );
  console.log(
    "Real GitHub + separate stdio MCP clients + native startup command passed: identity, replies, acknowledgments, metadata-only edits/editor verification, escalation, delivery, close/reopen, local/remote disconnect. This does not test the Codex or Claude app UI.",
  );
} finally {
  if (request)
    await gh
      .api("PATCH", `/issues/${request.number}`, { state: "closed" })
      .catch(() => {});
  for (const { client } of clients) await client.close();
  for (const root of roots)
    await disconnect({
      cwd: root,
      log: (message) => {
        if (message.includes("pending")) console.error(message);
      },
    }).catch(() => {});
  if (previous === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = previous;
  await rm(dir, { recursive: true, force: true });
}
