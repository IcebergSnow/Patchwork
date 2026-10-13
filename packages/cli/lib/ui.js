import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { connect, disconnect, status, projectRoot, inferRepo, savedConnections } from "./connect.js";
import { disconnectPicker } from "./disconnect-picker.js";
import { run, repository } from "./github.js";
import { displayText } from "./previews.js";

export async function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Interactive input required. Use command flags or run Patchwork in a terminal.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  rl.on("SIGINT", () => rl.close());
  rl.on("close", () => abort.abort());
  try { return (await rl.question(question + " ", { signal: abort.signal })).trim(); }
  finally { rl.close(); }
}

export async function login(question = ask) {
  try { await run("gh", ["auth", "status", "--hostname", "github.com"]); }
  catch {
    if (!/^y(?:es)?$/i.test(await question("Sign in to GitHub using your browser? [y/N]")))
      throw new Error("GitHub login is required. Run gh auth login --hostname github.com when ready.");
    await new Promise((resolve, reject) => {
      const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"], { stdio: "inherit", shell: false });
      child.on("error", () => reject(new Error("Install GitHub CLI (gh), then reopen your terminal.")));
      child.on("exit", code => code === 0 ? resolve() : reject(new Error("GitHub sign-in did not complete.")));
    });
  }
}

const appName = app => app === "codex" ? "Codex" : "Claude Code";
const safe = value => displayText(value, 500);
function checked(value, now) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "never";
  const minutes = Math.floor(Math.max(0, now - time) / 60000);
  return minutes < 1 ? "less than a minute ago" : minutes < 60 ? `${minutes} minutes ago` : new Date(time).toLocaleString();
}
export function showStatus(result, { log = console.log, details = false, now = Date.now() } = {}) {
  if (details) {
    // Preserve JSON formatting without allowing terminal-control characters.
    for (const line of JSON.stringify(result, null, 2).split("\n")) log(line.replace(/^(\s*)(.*)$/, (_, indent, text) => indent + displayText(text, 4000)));
    return;
  }
  if (!Array.isArray(result)) {
    log(`\n${safe(result.repo)} — shared GitHub roster`);
    for (const agent of result.agents || [])
      log(`  ${safe(agent.name)} [${safe(agent.client)}] — ${agent.active ? "Registered" : "Retired"}`);
    if (!result.agents?.length) log("  No registered chats found.");
    for (const warning of result.warnings || []) log(`  Warning: ${safe(typeof warning === "string" ? warning : JSON.stringify(warning))}`);
    log("Registered includes idle chats. Message previews are available only on their own computer.");
    return;
  }
  if (!result.length) { log("No Patchwork connection in this project. Choose Connect / update an app."); return; }
  for (const group of result) {
    log(`\n${appName(group.client)} — ${safe(group.repo)}`);
    log(`Folder: ${safe(group.project)}`);
    log(`Setup: ${!group.enabled ? "Disabled" : group.configured ? "Configured" : "Needs repair — rerun connect, then reload the app"}`);
    for (const chat of group.chats) {
      const state = chat.pendingRetirement ? "GitHub cleanup pending" : !chat.enabled ? "Disconnected" : chat.lastError ? "Check failed" : !chat.lastBoardCheck ? "Awaiting first check" : "Enabled";
      log(`  ${safe(chat.name)} — ${state}`);
      log(`    ${chat.latestUserMessage ? `“${safe(chat.latestUserMessage)}”` : "Message preview unavailable"}`);
      log(`    Last successful check: ${checked(chat.lastBoardCheck, now)}`);
      if (chat.lastError) log(`    Error: ${safe(chat.lastError)}`);
      if (chat.pendingWrite) log("    A write is pending. Retry the same operation in the coding chat.");
    }
    if (!group.chats.length) log("  No chats yet. Start a saved chat after reloading the app and approving hooks/MCP.");
    if (group.apiUsage?.cooldownUntil) log(`GitHub cooldown until ${safe(group.apiUsage.cooldownUntil)}. Retry afterward.`);
  }
  log("Enabled is local connection state, not live presence. Latest-message previews stay local.");
}

async function choose(question, options, prompt, log) {
  options.forEach((option, i) => log(`${i + 1}. ${option.label}`));
  log("0. Back / exit");
  for (;;) {
    const answer = (await prompt(question)).trim();
    if (!answer || /^(0|q|quit)$/i.test(answer)) return null;
    const index = Number(answer) - 1;
    if (/^\d+$/.test(answer) && options[index]) return options[index].value;
    log(`Choose a number from 0 to ${options.length}.`);
  }
}
const yes = answer => /^y(?:es)?$/i.test(answer.trim());
export async function requirements() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Install Node.js 22.13 or newer, then reopen your terminal.");
  for (const [command, label] of [["git", "Git"], ["gh", "GitHub CLI (gh)"]]) {
    try { await run(command, ["--version"]); }
    catch { throw new Error(`Install ${label} and ensure it is on your PATH, then reopen your terminal.`); }
  }
}

export async function menu({ cwd = process.cwd(), prompt = ask, log = console.log, env, github,
  signIn = login, checkRequirements = requirements,
  openBoard = c => run("gh", ["issue", "view", String(c.board), "--repo", c.repo, "--web"]),
} = {}) {
  if (prompt === ask && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error("The menu requires a terminal. Use --help for commands; status --json supports scripts.");
  const choice = (title, items) => choose(title, items.map(([label, value]) => ({ label, value })), prompt, log);
  const warn = error => log(`\nCould not complete that action: ${error instanceof SyntaxError ? "Saved local data is malformed. Check the connection files before retrying." : safe(error.message)}\n`);
  const getSaved = async () => {
    const result = await savedConnections();
    result.warnings.forEach(log);
    return result.connections;
  };
  const localStatus = connections => Promise.all(connections.map(async saved => (await status({ saved, env }))[0]));
  const pickApp = async connections => connections.length === 1 ? connections[0] :
    choice("Choose an app:", connections.map(c => [`${appName(c.client)} — ${safe(c.repo)}`, c]));

  async function setup(root) {
    await checkRequirements();
    if (!root) throw new Error("Open a terminal in your project's Git checkout, then run Patchwork again. Saved projects can still be managed here.");
    const client = await choice("Connect which app?", [["Codex", "codex"], ["Claude Code", "claude"]]);
    if (!client) return;
    const existing = (await getSaved()).find(c => c.root === root && c.client === client);
    const origin = await inferRepo(root).catch(() => null);
    const suggested = existing?.repo || origin;
    log(`Folder: ${safe(root)}`);
    log(`GitHub origin: ${safe(origin || "not detected")}`);
    if (existing) log(`Saved ${appName(client)} connection: ${safe(existing.repo)}`);
    const repo = repository((await prompt(`GitHub repository${suggested ? ` [${safe(suggested)}]` : " (OWNER/REPO)"}:`)).trim() || suggested || "");
    if (!yes(await prompt(`Connect ${appName(client)} in ${safe(root)} to ${safe(repo)}? [y/N]`))) { log("Cancelled. No connection changed."); return; }
    await signIn(prompt);
    await connect({ cwd: root, client, repo, github, log, confirm: q => prompt(`${safe(q)} [y/N]`).then(yes) });
    log("Next: reload the coding app, approve project/MCP/hook permissions, and start a saved chat. View chats to confirm its first successful check.");
  }

  async function manage(root, current = false) {
    for (;;) {
      const connections = (await getSaved()).filter(c => c.root === root);
      log(`\nPatchwork — ${safe(path.basename(root))}`);
      log(`Folder: ${safe(root)}`);
      for (const c of connections) log(`${appName(c.client)}: ${safe(c.repo)} — ${c.enabled ? "Enabled" : "Disabled"}${c.folderAvailable ? "" : " · Folder unavailable"}`);
      if (!connections.length) log(`GitHub origin: ${safe(await inferRepo(root).catch(() => "not detected"))}`);
      const selected = await choice("Choose an action:", [
        ...(connections.length ? [["View chats", "chats"], ["Open GitHub board", "board"]] : []),
        ["Connect / update an app", "connect"],
        ...(connections.length ? [["Disconnect", "disconnect"]] : []),
        ...(current ? [["Manage other projects", "projects"]] : []),
      ]);
      if (!selected) return;
      try {
        if (selected === "connect") await setup(root);
        if (selected === "projects") await projects();
        if (selected === "board") {
          const c = await pickApp(connections);
          if (c) { await status({ saved: c, env }); await openBoard(c); }
        }
        if (selected === "chats") {
          showStatus(await localStatus(connections), { log });
          for (;;) {
            const view = await choice("More:", [["Shared GitHub roster", "remote"], ["Details (IDs and API usage)", "details"]]);
            if (!view) break;
            if (view === "details") showStatus(await localStatus(connections), { log, details: true });
            else {
              const c = await pickApp(connections);
              if (c) { await signIn(prompt); showStatus(await status({ repo: c.repo, github }), { log }); }
            }
          }
        }
        if (selected === "disconnect") {
          const scope = await choice("Disconnect:", [["Select individual chats", "chats"], ["Entire project on this computer", "project"]]);
          if (scope === "chats") {
            const saved = await pickApp(connections);
            if (saved) await disconnectPicker({ saved, env, ask: prompt, github, log });
          }
          if (scope === "project") {
            await localStatus(connections); // Validate selections before confirmation.
            log(`Disconnect from ${safe(root)}:`);
            connections.forEach(c => log(`  ${appName(c.client)} — ${safe(c.repo)}`));
            log("This disables the listed apps locally and retires their chats. Teammates on other computers stay connected.");
            if (yes(await prompt("Disconnect this project? [y/N]")))
              for (const saved of connections) await disconnect({ saved, github, log });
            else log("Cancelled. No chats changed.");
          }
        }
      } catch (e) { if (e.name === "AbortError") throw e; warn(e); }
    }
  }

  async function projects() {
    const connections = await getSaved();
    const roots = [...new Set(connections.map(c => c.root))];
    if (!roots.length) { log("No saved project connections on this computer."); return; }
    log("\nSaved projects on this computer");
    const root = await choice("Choose a project:", roots.map(root => {
      const group = connections.filter(c => c.root === root);
      return [`${safe(root)} — ${group.map(c => `${appName(c.client)}: ${safe(c.repo)} (${c.enabled ? "enabled" : "disabled"})`).join("; ")}${group.every(c => c.folderAvailable) ? "" : " · Folder unavailable"}`, root];
    }));
    if (root) await manage(root);
  }

  try {
    const root = await projectRoot(cwd).catch(() => null);
    if (root) await manage(root, true);
    else for (;;) {
      log(`\nPatchwork\nCurrent folder: ${safe(cwd)}\nNo Git project detected here.`);
      const action = await choice("Choose an action:", [["Manage connected projects", "projects"], ["Connect this folder", "connect"]]);
      if (!action) break;
      try { if (action === "projects") await projects(); else await setup(null); }
      catch (e) { if (e.name === "AbortError") throw e; warn(e); }
    }
  } catch (e) { if (e.name !== "AbortError") throw e; log("Cancelled."); }
}
