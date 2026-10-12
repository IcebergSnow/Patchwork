import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { realpath, unlink } from "node:fs/promises";
import { run, GitHub, repository } from "./github.js";
import {
  createBoard,
  findBoard,
  register,
  snapshot,
  reconcileIntervention,
} from "./board.js";
import {
  connectionFile,
  read,
  readJSON,
  write,
  writeJSON,
  locked,
  directory,
} from "./store.js";
import { mergeCodex, mergeClaude, mergeHooks, parseConfig } from "./config.js";
import { hookConfiguration, serverConfiguration } from "./connections.js";
import { disabledFile, stateFile } from "./runtime.js";
export const ENTRY = fileURLToPath(
  new URL("../bin/patchwork.js", import.meta.url),
);
export async function projectRoot(cwd = process.cwd()) {
  return realpath(
    (await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).trim(),
  );
}
export async function inferRepo(root) {
  const remote = (
    await run("git", ["-C", root, "remote", "get-url", "origin"])
  ).trim();
  const match = remote.match(
    /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (!match)
    throw new Error("Specify --repo OWNER/REPO for a github.com repository.");
  return repository(match[1]);
}
function settings(root, client, claudeFile) {
  return client === "codex"
    ? {
        config: path.join(root, ".codex/config.toml"),
        hooks: path.join(root, ".codex/hooks.json"),
      }
    : {
        config: claudeFile || path.join(os.homedir(), ".claude.json"),
        hooks: path.join(root, ".claude/settings.local.json"),
      };
}
async function checkUntracked(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith("..")) return;
  if ((await run("git", ["-C", root, "ls-files", "--", relative])).trim())
    throw new Error(
      `Refusing to write machine-specific connection data into tracked file ${relative}. Keep this file local first.`,
    );
}
async function ignoreLocal(root, files) {
  const gitPath = (
    await run("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"])
  ).trim();
  const file = path.resolve(root, gitPath),
    original = await read(file);
  const paths = files
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .filter((p) => !p.startsWith(".."));
  const additions = paths
    .map((p) => "/" + p)
    .filter((p) => !original.split(/\r?\n/).includes(p));
  if (additions.length)
    await write(
      file,
      original +
        (original && !original.endsWith("\n") ? "\n" : "") +
        additions.join("\n") +
        "\n",
    );
}
export async function connect({
  repo,
  client,
  name,
  cwd,
  create = false,
  confirm = async () => false,
  log = console.log,
  github,
  claudeFile,
  entry = ENTRY,
} = {}) {
  const root = await projectRoot(cwd);
  if (!["codex", "claude"].includes(client))
    throw new Error("Choose --client codex or --client claude.");
  repo = repository(repo || (await inferRepo(root)));
  const file = connectionFile(root, client);
  return locked(file, async () => {
    let existing = await readJSON(file);
    if (
      existing &&
      (existing.repo.toLowerCase() !== repo.toLowerCase() ||
        existing.root !== root)
    ) {
      const previous = await readJSON(stateFile(file));
      if (
        existing.enabled ||
        Object.values(previous?.chats || {}).some((a) => a.registered)
      )
        throw new Error(
          "This project is connected elsewhere. Finish disconnecting it online before choosing another board.",
        );
      await writeJSON(stateFile(file), { chats: {} });
      existing = null;
    }
    const files = settings(root, client, claudeFile);
    for (const f of Object.values(files)) {
      await directory(path.dirname(f));
      await checkUntracked(root, f);
    }
    const before = {
      config: await read(files.config),
      hooks: await read(files.hooks),
    };
    const server = serverConfiguration(entry, file),
      claudeServer = { type: "stdio", ...server };
    const desired = client === "codex" ? server : claudeServer;
    const previousServer = existing?.installing
      ? existing.previousServer
      : existing?.server;
    const previousHooks = [
      ...(existing?.ownedHooks || []),
      ...(existing?.previousHooks || []),
    ];
    const nextConfig =
      client === "codex"
        ? mergeCodex(before.config, desired, previousServer)
        : mergeClaude(before.config, root, desired, previousServer);
    const nextHooks = mergeHooks(
      before.hooks,
      entry,
      file,
      previousHooks,
      false,
      client === "codex" ? parseConfig(before.config).hooks || {} : {},
    );
    const gh = github || new GitHub(repo);
    const { user, repo: remote } = await gh.verify(existing || {});
    let board = await findBoard(gh);
    if (!board) {
      if (
        !create &&
        !(await confirm(`Create the shared Patchwork board in ${repo}?`))
      )
        throw new Error(
          "No board exists. Ask a teammate to create it, or rerun with --create-board.",
        );
      board = await createBoard(gh);
    }
    if (existing?.board && existing.board !== board.number)
      throw new Error(
        "The repository board changed. Review the new board before replacing this connection.",
      );
    const c = {
      ...existing,
      version: 1,
      enabled: true,
      installing: true,
      previousServer,
      previousHooks,
      root,
      client,
      repo,
      repoId: remote.id,
      ownerId: user.id,
      login: user.login,
      board: board.number,
      boardUrl: board.html_url,
      name: (name || existing?.name || `${user.login} / ${client}`).trim(),
      files,
      server: desired,
      entry,
      ownedHooks: Object.values(hookConfiguration(entry, file).hooks).flatMap(
        (g) => g.flatMap((x) => x.hooks),
      ),
    };
    if (!c.name || c.name.length > 60)
      throw new Error("Use a connection name between 1 and 60 characters.");
    await write(disabledFile(file), "installing\n");
    await writeJSON(file, c);
    await ignoreLocal(root, Object.values(files));
    if (
      (await read(files.config)) !== before.config ||
      (await read(files.hooks)) !== before.hooks
    )
      throw new Error(
        "Agent settings changed during installation. Rerun to merge the latest files.",
      );
    await checkUntracked(root, files.config);
    await checkUntracked(root, files.hooks);
    if (nextConfig !== before.config) await write(files.config, nextConfig);
    if (nextHooks !== before.hooks) await write(files.hooks, nextHooks);
    delete c.previousServer;
    delete c.previousHooks;
    c.installing = false;
    await writeJSON(file, c);
    await unlink(disabledFile(file)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    log(`Connected ${client} for chats in ${root}.`);
    log(`Board: ${board.html_url}`);
    log(
      "Restart/open a new chat and review required MCP/hook permissions. Status will show the first successful board check.",
    );
    return { file, connection: c };
  });
}
export async function status({ cwd, client } = {}) {
  const root = await projectRoot(cwd),
    results = [];
  for (const app of client ? [client] : ["codex", "claude"]) {
    const file = connectionFile(root, app),
      c = await readJSON(file);
    if (!c) continue;
    const sessions = await readJSON(stateFile(file));
    let configured = false;
    try {
      const config = await read(c.files.config),
        hooks = await read(c.files.hooks);
      configured =
        (app === "codex"
          ? mergeCodex(config, c.server, c.server)
          : mergeClaude(config, root, c.server, c.server)) === config &&
        mergeHooks(hooks, c.entry, file, c.ownedHooks) === hooks;
    } catch {}
    results.push({
      client: app,
      project: root,
      repo: c.repo,
      board: c.boardUrl,
      enabled: c.enabled && !(await read(disabledFile(file))),
      chats: await Promise.all(
        Object.values(sessions?.chats || {}).map(async (a) => ({
          id: a.id,
          name: a.name,
          enabled:
            c.enabled &&
            !(await read(disabledFile(file))) &&
            !(await read(disabledFile(file, a.id))),
          lastBoardCheck: a.lastSuccess || null,
          lastError: a.lastError || null,
          pendingWrite: !!a.pending,
        })),
      ),
      configured,
    });
  }
  return results;
}
export async function disconnect({
  cwd,
  client,
  agent,
  github,
  log = console.log,
} = {}) {
  const root = await projectRoot(cwd);
  let found = false;
  for (const app of client ? [client] : ["codex", "claude"]) {
    const file = connectionFile(root, app),
      c = await readJSON(file);
    if (!c) continue;
    const original = await readJSON(stateFile(file));
    if (
      agent &&
      !Object.values(original?.chats || {}).some((a) => a.id === agent)
    )
      continue;
    found = true;
    await write(disabledFile(file, agent), "disconnected\n");
    await locked(file, async () => {
      if (!agent) {
        c.enabled = false;
        await writeJSON(file, c);
        try {
          const before = {
            config: await read(c.files.config),
            hooks: await read(c.files.hooks),
          };
          const next =
            app === "codex"
              ? mergeCodex(before.config, c.server, c.server, true)
              : mergeClaude(before.config, root, c.server, c.server, true);
          const hooks = mergeHooks(
            before.hooks,
            c.entry,
            file,
            c.ownedHooks,
            true,
          );
          if (next !== before.config) await write(c.files.config, next);
          if (hooks !== before.hooks) await write(c.files.hooks, hooks);
        } catch {
          log(
            "Disabled locally. Modified agent settings were preserved; remove the remaining Patchwork entries manually.",
          );
        }
      }
      await locked(stateFile(file), async () => {
        const state = await readJSON(stateFile(file));
        const chats = Object.values(state?.chats || {}).filter(
          (a) => !agent || a.id === agent,
        );
        try {
          const gh = github || new GitHub(c.repo);
          await gh.verify(c);
          for (const chat of chats) {
            chat.retireOperation ??= crypto.randomUUID();
            await writeJSON(stateFile(file), state);
            await register(gh, c.board, chat, false, chat.retireOperation);
            chat.registered = false;
            chat.registrationOperation = crypto.randomUUID();
            await writeJSON(stateFile(file), state);
          }
          await reconcileIntervention(gh, await snapshot(gh, c.board));
        } catch {
          log(
            "Local disconnect succeeded. GitHub roster cleanup is pending; rerun disconnect when connectivity/access returns.",
          );
        }
      });
    });
    log(
      agent
        ? `Disconnected chat ${agent}.`
        : `Disconnected ${app} for this project. Restart existing chats to unload tools. GitHub history and login are unchanged.`,
    );
  }
  if (!found)
    throw new Error(
      "No matching local Patchwork connection or chat was found.",
    );
}
