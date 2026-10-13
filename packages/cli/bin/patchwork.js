#!/usr/bin/env node
import { parseArgs } from "node:util";
import { connect, status, disconnect } from "../lib/connect.js";
import { Runtime } from "../lib/runtime.js";
import { serve } from "../lib/mcp.js";
import { ask, login, menu, showStatus } from "../lib/ui.js";

const HELP = `Patchwork — a GitHub bulletin board for independent coding agents.

Run patchwork without arguments for the guided menu.

Usage (inside your coding project's Git worktree):
  patchwork connect [--repo OWNER/REPO] [--client codex|claude] [--name NAME] [--create-board] [--agent CHAT_ID]
  patchwork status [--client codex|claude] [--repo OWNER/REPO] [--json]
  patchwork menu
  patchwork disconnect [--client codex|claude] [--agent CHAT_ID] [--repo OWNER/REPO]
  patchwork disconnect --select [--client codex|claude]

Requires Node.js 22.13+, Git, GitHub CLI (gh), and repository write access.
Connect affects chats in this project only. Each chat gets its own identity.
Local status includes the first sentence of each chat's latest user message, when available.
Disconnect without --agent or --select disables the selected app (both apps if omitted).
Use disconnect --select to pick individual chats with local message previews.
Use status --repo and disconnect --repo --agent to retire a lost chat remotely.
Use connect --client APP --agent CHAT_ID to explicitly resume a local chat.
GitHub credentials remain with gh. No Cloudflare account or pairing code.
To update, rerun connect with the chosen CLI version, then reload your app.
`;
let command;
try {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      client: { type: "string" },
      name: { type: "string" },
      "create-board": { type: "boolean" },
      agent: { type: "string" },
      connection: { type: "string" },
      select: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  command = args.positionals[0];
  if (args.values.help || (!command && (!process.stdin.isTTY || !process.stdout.isTTY))) {
    console.log(HELP);
  } else if (!command || command === "menu") {
    if (args.positionals.length > 1 || Object.keys(args.values).length) throw new Error("Run patchwork menu without flags, or use an explicit command.");
    await menu();
  } else {
    if (args.positionals.length !== 1) throw new Error("Use patchwork --help.");
    const { client, repo, name, agent, connection } = args.values;
    if (args.values.json && command !== "status") throw new Error("Use --json only with status.");
    if (args.values.select && (command !== "disconnect" || agent || repo))
      throw new Error("Use --select only with disconnect in the local project, without --agent or --repo.");
    if (client && !["codex", "claude"].includes(client))
      throw new Error("Choose --client codex or --client claude.");
    if (command === "connect") {
      const selected =
        client ||
        (await ask("Connect which app? codex / claude:")).toLowerCase();
      await login();
      await connect({
        repo,
        client: selected,
        name,
        agent,
        create: args.values["create-board"],
        confirm: async (q) => /^y(es)?$/i.test(await ask(q + " [y/N]")),
      });
    } else if (command === "status") {
      const result = await status({ client, repo });
      if (args.values.json || !process.stdout.isTTY) console.log(JSON.stringify(result, null, 2));
      else showStatus(result);
    } else if (command === "disconnect") {
      if (args.values.select) {
        const { disconnectPicker } = await import("../lib/disconnect-picker.js");
        await disconnectPicker({ client });
      } else await disconnect({ client, agent, repo });
    } else if (command === "mcp") {
      if (!connection) throw new Error("Missing local connection path.");
      await serve(connection);
    } else if (command === "hook") {
      if (!connection) throw new Error("Missing local connection path.");
      let raw = "";
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (raw.length > 1_000_000) throw new Error("Hook input too large.");
      }
      const input = JSON.parse(raw);
      // The transcript path only distinguishes saved Codex chats from ephemeral
      // helpers. Never read/persist/upload transcripts, prompts or tool output.
      console.log(
        JSON.stringify(
          await new Runtime(connection).hook({
            session_id: input.session_id,
            hook_event_name: input.hook_event_name,
            transcript_path: input.transcript_path,
          }),
        ),
      );
    } else throw new Error("Unknown command. Use patchwork --help.");
  }
} catch (e) {
  if (e.name === "AbortError") {
    console.log("Cancelled.");
  } else if (command === "hook") {
    console.error(
      "Patchwork board check unavailable. Use patchwork status; coding can continue.",
    );
    console.log("{}");
  } else {
    console.error(
      e.message || "Patchwork failed. Check local permissions and retry.",
    );
    process.exitCode = 1;
  }
}
