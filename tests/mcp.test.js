import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../packages/cli/lib/mcp.js";
import { Runtime, stateFile } from "../packages/cli/lib/runtime.js";
import { readJSON } from "../packages/cli/lib/store.js";
import { connection } from "./fixtures.js";
import { readFile } from "node:fs/promises";
test("real MCP protocol exposes narrow tools, rejects old recipient parameters and isolates chat acknowledgments", async (t) => {
  const { file, gh } = await connection(t);
  const runtime = new Runtime(file, { github: gh });
  await runtime.hook({ transcript_path: "/test/transcript.jsonl", session_id: "one", hook_event_name: "SessionStart" });
  const chat = Object.values((await readJSON(stateFile(file))).chats)[0];
  const mcp = server(runtime),
    client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });
  const pkg = JSON.parse(await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
  assert.equal(client.getServerVersion().version, pkg.version);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    "acknowledge_request",
    "check_board",
    "post_message",
    "read_messages",
    "resolve_request",
  ]);
  const calls = gh.calls;
  for (const hook_event_name of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
    const ignored = await client.callTool({
      name: "check_board",
      arguments: { session_id: "ephemeral-helper", hook_event_name, transcript_path: null },
    });
    assert(!ignored.isError);
    assert.deepEqual(JSON.parse(ignored.content[0].text), {});
  }
  const oldHook = await client.callTool({
    name: "check_board",
    arguments: { session_id: "unknown", hook_event_name: "UserPromptSubmit" },
  });
  assert(oldHook.isError);
  assert.match(oldHook.content[0].text, /Rerun connect/);
  assert.equal(gh.calls, calls);
  const welcome = await client.callTool({
    name: "check_board",
    arguments: { session_id: "two", hook_event_name: "SessionStart", transcript_path: "C:\\Codex\\sessions\\saved.jsonl" },
  });
  assert(!welcome.isError);
  const [first, second] = Object.values((await readJSON(stateFile(file))).chats);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.chat_key, second.chat_key);
  assert(!JSON.stringify(await readJSON(stateFile(file))).includes("saved.jsonl"));
  const posted = await client.callTool({
    name: "post_message",
    arguments: {
      chat_key: chat.chat_key,
      kind: "request",
      body: "Protocol request",
    },
  });
  assert(!posted.isError);
  const id = JSON.parse(posted.content[0].text).number;
  assert(id > 0);
  const invalid = await client.callTool({
    name: "post_message",
    arguments: { chat_key: chat.chat_key, body: "bad", recipientId: "other" },
  });
  assert(invalid.isError);
  const missing = await client.callTool({
    name: "acknowledge_request",
    arguments: { request_id: id, response: "cannot_handle" },
  });
  assert(missing.isError);
});
