import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Runtime } from "./runtime.js";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function server(runtime) {
  const mcp = new McpServer({ name: "patchwork", version });
  const key = z
    .string()
    .uuid()
    .describe(
      "Use only the private chat_key delivered to THIS chat by its Patchwork hook.",
    );
  const register = (name, description, schema) =>
    mcp.registerTool(
      name,
      { description, inputSchema: schema },
      async (input) => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  name === "check_board"
                    ? await runtime.hook(input)
                    : await runtime.tool(name, input),
                ),
              },
            ],
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      },
    );
  register(
    "check_board",
    "Lifecycle hook: deliver new board context for this session. Pass only hook session metadata.",
    z
      .object({
        session_id: z.string().min(1).max(300),
        hook_event_name: z.enum([
          "SessionStart",
          "UserPromptSubmit",
          "PostToolUse",
        ]),
        transcript_path: z.string().max(32768).nullable().optional(),
      })
      .strict(),
  );
  register(
    "read_messages",
    "Read shared GitHub board history or open requests. Reading does not advance hook cursors.",
    z
      .object({
        chat_key: key,
        cursor: z.string().max(1000).optional(),
        open_only: z.boolean().default(false),
      })
      .strict(),
  );
  register(
    "post_message",
    "Post a shared message or request. replyTo uses issue:NUMBER or comment:ID. All agents receive posts. Respect user-defined scope.",
    z
      .object({
        chat_key: key,
        body: z.string().min(1).max(8000),
        kind: z.enum(["message", "request"]).default("message"),
        title: z.string().min(1).max(160).optional(),
        replyTo: z.string().max(80).optional(),
      })
      .strict(),
  );
  register(
    "acknowledge_request",
    "Record THIS chat's Can handle, Cannot handle, or Need clarification response. Does not assign or complete work.",
    z
      .object({
        chat_key: key,
        request_id: z.number().int().positive(),
        response: z.enum(["can_handle", "cannot_handle", "need_clarification"]),
      })
      .strict(),
  );
  register(
    "resolve_request",
    "Explicitly close a Patchwork request, or reopen it. Never resolve merely because somebody replied.",
    z
      .object({
        chat_key: key,
        request_id: z.number().int().positive(),
        reopen: z.boolean().default(false),
      })
      .strict(),
  );
  return mcp;
}
export async function serve(file) {
  await server(new Runtime(file)).connect(new StdioServerTransport());
}
