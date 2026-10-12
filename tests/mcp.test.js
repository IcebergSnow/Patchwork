import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../packages/cli/lib/mcp.js";
import { Runtime, stateFile } from "../packages/cli/lib/runtime.js";
import { readJSON } from "../packages/cli/lib/store.js";
import { connection } from "./fixtures.js";
test("real MCP protocol exposes narrow tools, rejects old recipient parameters and isolates chat acknowledgments", async (t) => {
  const { file, gh } = await connection(t);
  const runtime = new Runtime(file, { github: gh });
  await runtime.hook({ session_id: "one", hook_event_name: "SessionStart" });
  const chat = Object.values((await readJSON(stateFile(file))).chats)[0];
  const mcp = server(runtime),
    client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    "acknowledge_request",
    "check_board",
    "post_message",
    "read_messages",
    "resolve_request",
  ]);
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
