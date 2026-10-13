import { createInterface } from "node:readline/promises";
import { projectRoot, status, disconnect } from "./connect.js";
import { connectionFile, readJSON } from "./store.js";
import { displayText } from "./previews.js";

export async function disconnectChoices({ cwd, client, env, saved } = {}) {
  const root = saved ? saved.root : await projectRoot(cwd);
  const choices = [];
  for (const group of await status({ cwd: root, client, env, saved })) {
    const eligible = group.chats.filter(chat => chat.enabled || chat.pendingRetirement);
    for (const chat of eligible) choices.push({
      id: chat.id,
      client: group.client,
      repo: group.repo,
      name: chat.name,
      lastBoardCheck: chat.lastBoardCheck,
      pendingRetirement: chat.pendingRetirement,
      preview: chat.latestUserMessage,
    });
  }
  return { root, choices };
}

export function selection(answer, count) {
  answer = answer.trim();
  if (!answer || /^q(?:uit)?$/i.test(answer)) return [];
  const values = answer.split(/[\s,]+/);
  if (values.some(value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > count))
    throw new Error(`Choose numbers from 1 to ${count}, separated by spaces or commas.`);
  return [...new Set(values.map(value => Number(value) - 1))];
}

export async function disconnectPicker({ cwd, client, env, ask, log = console.log, github, saved } = {}) {
  let rl;
  if (!ask) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("The disconnect picker requires a terminal. Use disconnect --agent CHAT_ID for scripts.");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const abort = new AbortController();
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => abort.abort());
    ask = question => rl.question(question + " ", { signal: abort.signal });
  }
  try {
    const { root, choices } = await disconnectChoices({ cwd, client, env, saved });
    if (!choices.length) {
      log("No local chats to disconnect.");
      return;
    }
    log("Disconnect chats — this project");
    log(`Folder: ${displayText(root, 300)}`);
    log("Latest user message previews stay local. Enter cancels.\n");
    choices.forEach((chat, i) => {
      const date = Date.parse(chat.lastBoardCheck);
      const checked = Number.isFinite(date) ? new Date(date).toLocaleString() : "never";
      log(`${i + 1}. ${displayText(chat.name, 80)} [${chat.client}]`);
      log(`   ${displayText(chat.id)} | checked: ${checked}${chat.pendingRetirement ? " | GitHub cleanup pending" : ""}`);
      log(`   ${chat.preview ? `“${chat.preview}”` : "Preview unavailable"}\n`);
    });
    let picked;
    while (!picked) {
      const answer = await ask("Numbers to disconnect (e.g. 1, 3), or Enter to cancel:");
      try { picked = selection(answer, choices.length); } catch (e) { log(e.message); }
    }
    if (!picked.length) { log("Cancelled. No chats changed."); return; }
    const selected = picked.map(i => choices[i]);
    log("\nSelected:");
    for (const chat of selected) log(`- ${displayText(chat.name, 80)} [${chat.client}] — ${displayText(chat.repo)} (${displayText(chat.id)})`);
    if (!/^y(?:es)?$/i.test((await ask(`Disconnect ${selected.length} chat(s)? [y/N]`)).trim())) {
      log("Cancelled. No chats changed.");
      return;
    }
    rl?.close(); // Restore normal Ctrl+C behavior during network operations.
    // Never hold locks while waiting for input. Pin the project/board selection
    // again before reusing the existing individually scoped disconnect path.
    for (const chat of selected) {
      const current = await readJSON(connectionFile(root, chat.client));
      if (current?.repo !== chat.repo || current.root !== root)
        throw new Error("The project connection changed. Reopen the picker before disconnecting.");
      await disconnect({ cwd: root, client: chat.client, agent: chat.id, github, log, saved });
    }
  } catch (e) {
    if (e.name === "AbortError") log("Cancelled.");
    else throw e;
  } finally {
    rl?.close();
  }
}
