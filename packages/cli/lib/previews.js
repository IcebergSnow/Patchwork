import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { digest } from "./store.js";

const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const TAIL_BYTES = 1024 * 1024;
const sentence = new Intl.Segmenter("en", { granularity: "sentence" });

export function displayText(value, limit = 160) {
  const clean = stripVTControlCharacters(String(value ?? ""))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : clean;
}

export function firstSentence(text) {
  // Desktop context and CLI command output are not the user's message.
  text = text.replace(/<(environment_context|in-app-browser-context|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();
  if (/^(?:# AGENTS\.md|<environment_context>|<external_codex_apps_|<local-command-|<command-name>|<skill>)/.test(text)) return null;
  text = text.replace(/^## My request:\s*/, "");
  const clean = displayText(text, 4096);
  return clean ? displayText(sentence.segment(clean)[Symbol.iterator]().next().value.segment) : null;
}

// undefined = not a human message; null = human message with no previewable text.
// Recognize only known transcript records. Unknown layouts fail to a placeholder.
function userMessage(record, client, sessionId) {
  if (client === "codex") {
    const p = record.payload;
    if (record.type === "event_msg" && p?.type === "user_message")
      return typeof p.message === "string" ? firstSentence(p.message) : null;
    if (record.type !== "response_item" || p?.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return;
    const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
    if (Array.isArray(kinds) && !kinds.some(k => typeof k === "string" && k.startsWith("user."))) return;
    const parts = p.content.filter((b, i) => b?.type === "input_text" && typeof b.text === "string" && (!Array.isArray(kinds) || kinds[i] === "user.text"));
    const text = parts.map(b => b.text).join("\n");
    const preview = firstSentence(text);
    // Older transcripts have no kind tags; skip recognizable injected context.
    return preview || (Array.isArray(kinds) || !text ? null : undefined);
  }
  if (record.type !== "user" || record.sessionId !== sessionId || record.isMeta || record.isCompactSummary || record.isSidechain || record.message?.role !== "user") return;
  const content = record.message.content;
  if (typeof content === "string") return firstSentence(content) ?? undefined;
  if (!Array.isArray(content) || content.some(b => b?.type === "tool_result")) return;
  return firstSentence(content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n"));
}

async function previewFile(file, root, client, sessionId) {
  let handle;
  try {
    const resolved = await realpath(file);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) return null;
    if (client === "codex") {
      const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const meta = JSON.parse(head.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
      if (meta.type !== "session_meta" || meta.payload?.id !== sessionId) return null;
    }
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(tail, 0, tail.length, start);
    const lines = tail.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start) lines.shift(); // Never parse a partial leading record.
    for (let i = lines.length - 1; i >= 0; i--) {
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      const result = userMessage(record, client, sessionId);
      if (result !== undefined) return result;
    }
  } catch {
    // Missing, inaccessible, changing, or unfamiliar transcripts are optional.
  } finally {
    await handle?.close();
  }
  return null;
}

export async function chatPreviews(client, sessionHashes, env = process.env) {
  const previews = new Map();
  if (!sessionHashes.size) return previews;
  const base = client === "codex"
    ? env.CODEX_HOME || path.join(os.homedir(), ".codex")
    : env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const roots = client === "codex" ? ["sessions", "archived_sessions"] : ["projects"];
  const pattern = new RegExp(client === "codex" ? `^rollout-.*-(${UUID})\\.jsonl$` : `^(${UUID})\\.jsonl$`, "i");
  let visited = 0;
  // On-demand filename lookup supports existing chats without changing hooks or
  // persisting paths/prompts. Read only files matching this project's saved IDs.
  for (const dir of roots) {
    let root;
    try { root = await realpath(path.join(base, dir)); } catch { continue; }
    const pending = [{ file: root, depth: 0 }];
    while (pending.length && visited < 10_000) {
      const current = pending.pop();
      try {
        const entries = await opendir(current.file);
        for await (const entry of entries) {
          if (++visited > 10_000) break;
          const file = path.join(current.file, entry.name);
          if (entry.isDirectory() && current.depth < (client === "codex" ? 3 : 1)) {
            pending.push({ file, depth: current.depth + 1 });
          } else if (entry.isFile()) {
            const match = entry.name.match(pattern);
            if (!match) continue;
            const hash = digest(`${client}\0${match[1]}`);
            if (!sessionHashes.has(hash) || previews.has(hash)) continue;
            const preview = await previewFile(file, root, client, match[1]);
            if (preview) previews.set(hash, preview);
          }
        }
      } catch { /* Skip unreadable directories; never infer retirement. */ }
    }
  }
  return previews;
}
