import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { symlink, unlink } from "node:fs/promises";
import {
  parseConfig,
  mergeCodex,
  mergeClaude,
  mergeHooks,
} from "../packages/cli/lib/config.js";
import {
  hookConfiguration,
  startupCommand,
  serverConfiguration,
} from "../packages/cli/lib/connections.js";
import {
  connect,
  disconnect,
  status,
  ENTRY,
} from "../packages/cli/lib/connect.js";
import { read, write, readJSON, writeJSON } from "../packages/cli/lib/store.js";
import { Runtime, stateFile, disabledFile } from "../packages/cli/lib/runtime.js";
import { run } from "../packages/cli/lib/github.js";
import { FakeGitHub, gitProject, temporary } from "./fixtures.js";
const server = {
  command: "/node",
  args: ["/patchwork", "mcp", "--connection", "/connection"],
};
const hooks = () =>
  Object.values(hookConfiguration("/patchwork", "/connection").hooks).flatMap(
    (g) => g.flatMap((x) => x.hooks),
  );
test("TOML merge/repeat/remove preserves settings; conflicts and malformed configs fail closed", () => {
  const source =
    '# keep\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n';
  const merged = mergeCodex(source, server);
  assert(merged.startsWith(source));
  assert.equal(mergeCodex(merged, server), merged);
  assert.deepEqual(
    parseConfig(mergeCodex(merged, server, server, true)),
    parseConfig(source),
  );
  assert.throws(
    () => mergeCodex(merged, { ...server, args: ["different"] }),
    /unowned/,
  );
  assert.throws(() => mergeCodex("bad = [", server));
  const inline = mergeCodex(
    'mcp_servers = { other = { command = "keep" } }',
    server,
  );
  assert.equal(parseConfig(inline).mcp_servers.other.command, "keep");
});
test("Claude installation remains private to one project, preserving global and other project settings", () => {
  const source = JSON.stringify({
    mcpServers: { global: { command: "keep" } },
    projects: {
      "/other": { mcpServers: { keep: { command: "x" } } },
      "/project": { allowedTools: ["Read"] },
    },
  });
  const desired = { type: "stdio", ...server },
    merged = mergeClaude(source, "/project", desired);
  assert.equal(mergeClaude(merged, "/project", desired), merged);
  const removed = JSON.parse(
    mergeClaude(merged, "/project", desired, desired, true),
  );
  assert.deepEqual(removed.projects["/project"].allowedTools, ["Read"]);
  assert.equal(removed.mcpServers.global.command, "keep");
  assert.equal(removed.projects["/other"].mcpServers.keep.command, "x");
});
test("hook merges deduplicate and remove only owned handlers, preserving mixed groups", () => {
  const source = JSON.stringify({
    permissions: { allow: ["Read"] },
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "echo keep" }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "echo finish" }] }],
    },
  });
  const merged = mergeHooks(source, "/patchwork", "/connection");
  assert.equal(
    mergeHooks(merged, "/patchwork", "/connection", hooks()),
    merged,
  );
  const removed = JSON.parse(
    mergeHooks(merged, "/patchwork", "/connection", hooks(), true),
  );
  assert.equal(removed.hooks.SessionStart[0].hooks[0].command, "echo keep");
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "echo finish");
  assert.deepEqual(removed.permissions.allow, ["Read"]);
  assert.throws(
    () =>
      mergeHooks("{}", "/patchwork", "/connection", [], false, {
        PostToolUse: [
          {
            hooks: [
              { type: "mcp_tool", server: "patchwork", tool: "check_board" },
            ],
          },
        ],
      }),
    /inline/,
  );
});
test("startup hook transports argv as data, not shell syntax; MCP hooks exclude board-tool recursion", () => {
  const entry = '/path with spaces/$(touch bad) `echo bad` "quote"/cli.js',
    file = "C:\\a b\\x.json";
  const command = startupCommand(entry, file);
  assert(!command.includes("touch bad"));
  const encoded = command.match(/Buffer.from\('([^']+)'/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString()), [
    entry,
    "hook",
    "--connection",
    file,
  ]);
  const h = hookConfiguration(entry, file);
  assert.equal(h.hooks.SessionStart[0].hooks[0].type, "command");
  for (const event of ["UserPromptSubmit", "PostToolUse"])
    assert.equal(h.hooks[event][0].hooks[0].input.transcript_path, "${transcript_path}");
  assert(
    !new RegExp(h.hooks.PostToolUse[0].matcher).test(
      "mcp__patchwork__post_message",
    ),
  );
});
test("command hooks forward only session metadata, including nullable transcript paths", async (t) => {
  const dir = await temporary(t), preload = path.join(dir, "assert-hook.mjs");
  const runtimeURL = new URL("../packages/cli/lib/runtime.js", import.meta.url).href;
  await write(preload, `import assert from "node:assert/strict";
import { Runtime } from ${JSON.stringify(runtimeURL)};
Runtime.prototype.hook = async function(input) {
  assert.deepEqual(Object.keys(input).sort(), ["hook_event_name", "session_id", "transcript_path"]);
  assert.equal(input.transcript_path, process.env.EXPECT_PATH || null);
  return {};
};`);
  for (const transcript_path of [null, path.join(dir, "saved.jsonl")]) {
    const output = await run(process.execPath, ["--import", preload, ENTRY, "hook", "--connection", path.join(dir, "connection.json")], {
      env: { ...process.env, EXPECT_PATH: transcript_path || "" },
      input: JSON.stringify({ session_id: "test", hook_event_name: "SessionStart", transcript_path, prompt: "private prompt", tool_output: "private output", transcript: "private transcript" }),
    });
    assert.deepEqual(JSON.parse(output), {});
  }
});

test("upgrading old hooks forwards transcript metadata once and keeps unrelated handlers", async (t) => {
  const root = await gitProject(t), dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub(), params = {
    cwd: root, client: "codex", repo: gh.repo, github: gh, create: true, log: () => {},
  };
  const { file } = await connect(params), c = await readJSON(file);
  const legacy = hookConfiguration(ENTRY, file);
  for (const groups of Object.values(legacy.hooks))
    for (const group of groups)
      for (const h of group.hooks)
        if (h.input) delete h.input.transcript_path;
  c.ownedHooks = Object.values(legacy.hooks).flatMap((g) => g.flatMap((x) => x.hooks));
  legacy.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "echo keep" }] });
  await writeJSON(file, c);
  await writeJSON(c.files.hooks, legacy);
  await connect(params);
  const upgraded = await read(c.files.hooks);
  await connect(params);
  assert.equal(await read(c.files.hooks), upgraded);
  const groups = JSON.parse(upgraded).hooks.UserPromptSubmit;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].hooks[0].command, "echo keep");
  assert.equal(groups[1].hooks[0].input.transcript_path, "${transcript_path}");
});
test("first install, repeated install, separate chats, disconnect, reconnect all preserve unrelated configs", async (t) => {
  const root = await gitProject(t),
    store = await temporary(t);
  process.env.PATCHWORK_HOME = store;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub();
  await write(path.join(root, ".codex/config.toml"), 'model = "keep"\n');
  const params = {
    cwd: root,
    client: "codex",
    repo: gh.repo,
    github: gh,
    create: true,
    log: () => {},
  };
  const { file } = await connect(params);
  const config = await read(path.join(root, ".codex/config.toml"));
  await connect(params);
  assert.equal(await read(path.join(root, ".codex/config.toml")), config);
  assert.equal(gh.issues.length, 1);
  const r = new Runtime(file, { github: gh });
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "one", hook_event_name: "SessionStart" });
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "two", hook_event_name: "SessionStart" });
  const [a, b] = Object.values((await readJSON(stateFile(file))).chats);
  await disconnect({ cwd: root, agent: a.id, github: gh, log: () => {} });
  await assert.rejects(
    r.tool("read_messages", { chat_key: a.chat_key }),
    /disconnected/,
  );
  assert((await r.tool("read_messages", { chat_key: b.chat_key })).agents);
  assert.equal((await status({ cwd: root }))[0].chats.length, 2);
  await disconnect({ cwd: root, github: gh, log: () => {} });
  assert.equal(
    parseConfig(await read(path.join(root, ".codex/config.toml"))).model,
    "keep",
  );
  await assert.rejects(
    r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "new", hook_event_name: "SessionStart" }),
    /disconnected/,
  );
  await connect(params);
  assert.equal((await status({ cwd: root }))[0].enabled, true);
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "new", hook_event_name: "SessionStart" });
});
test("Claude installer preserves existing settings and other projects on repeat/disconnect", async (t) => {
  const root = await gitProject(t),
    dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub(),
    claudeFile = path.join(dir, "claude.json");
  await write(
    claudeFile,
    JSON.stringify({
      projects: { "/other": { value: 1 } },
      mcpServers: { keep: { command: "x" } },
    }),
  );
  const params = {
    cwd: root,
    client: "claude",
    repo: gh.repo,
    github: gh,
    create: true,
    claudeFile,
    log: () => {},
  };
  await connect(params);
  await connect(params);
  await disconnect({ cwd: root, client: "claude", github: gh, log: () => {} });
  const c = JSON.parse(await read(claudeFile));
  assert.equal(c.projects["/other"].value, 1);
  assert.equal(c.mcpServers.keep.command, "x");
  assert(!c.projects[root].mcpServers.patchwork);
});
test("offline disconnect disables locally and reports pending roster cleanup", async (t) => {
  const root = await gitProject(t),
    dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub();
  const { file } = await connect({
    cwd: root,
    client: "codex",
    repo: gh.repo,
    github: gh,
    create: true,
    log: () => {},
  });
  const r = new Runtime(file, { github: gh });
  await r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "one", hook_event_name: "SessionStart" });
  gh.offline = true;
  const output = [];
  await disconnect({ cwd: root, github: gh, log: (x) => output.push(x) });
  assert(output.some((x) => x.includes("cleanup is pending")));
  await assert.rejects(
    r.hook({ transcript_path: "/test/transcript.jsonl", session_id: "one", hook_event_name: "SessionStart" }),
    /disconnected/,
  );
});
test("tracked and symlinked configuration stop setup before GitHub mutation", async (t) => {
  const root = await gitProject(t),
    dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub(),
    file = path.join(root, ".codex/config.toml");
  await write(file, 'model="keep"\n');
  await run("git", ["-C", root, "add", ".codex/config.toml"]);
  const params = {
    cwd: root,
    client: "codex",
    repo: gh.repo,
    github: gh,
    create: true,
    log: () => {},
  };
  await assert.rejects(connect(params), /tracked/);
  assert.equal(gh.issues.length, 0);
  if (process.platform !== "win32") {
    await run("git", ["-C", root, "rm", "--cached", ".codex/config.toml"]);
    await unlink(file);
    const target = path.join(dir, "target");
    await write(target, "");
    await symlink(target, file);
    await assert.rejects(connect(params), /linked/);
  }
});

test("an interrupted package-path upgrade can resume without overwriting other settings", async (t) => {
  const root = await gitProject(t),
    dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub(),
    params = {
      cwd: root,
      client: "codex",
      repo: gh.repo,
      github: gh,
      create: true,
      log: () => {},
    };
  const installed = await connect(params),
    old = await readJSON(installed.file),
    newEntry = path.join(dir, "new cli.js");
  const { writeJSON } = await import("../packages/cli/lib/store.js");
  await writeJSON(installed.file, {
    ...old,
    installing: true,
    previousServer: old.server,
    previousHooks: old.ownedHooks,
    server: serverConfiguration(newEntry, installed.file),
    entry: newEntry,
    ownedHooks: Object.values(
      hookConfiguration(newEntry, installed.file).hooks,
    ).flatMap((g) => g.flatMap((x) => x.hooks)),
  });
  await connect({ ...params, entry: newEntry });
  assert.equal(
    parseConfig(await read(old.files.config)).mcp_servers.patchwork.args[0],
    newEntry,
  );
  const configuredHooks = JSON.parse(await read(old.files.hooks));
  assert.equal(configuredHooks.hooks.SessionStart.length, 1);
  assert.equal((await status({ cwd: root }))[0].configured, true);
  await disconnect({ cwd: root, github: gh, log: () => {} });
  assert.equal((await status({ cwd: root }))[0].configured, false);
});

test("recovering an interrupted upgrade preserves remotely retired chats and cursors", async (t) => {
  const root = await gitProject(t), dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub(), params = {
    cwd: root, client: "codex", repo: gh.repo, github: gh, create: true, log: () => {},
  };
  const { file } = await connect(params);
  let now = Date.now();
  const runtime = new Runtime(file, { github: gh, clock: () => now });
  const input = { session_id: "retired", hook_event_name: "SessionStart", transcript_path: "/test/transcript.jsonl" };
  await runtime.hook(input);
  const before = await readJSON(stateFile(file)), [chat] = Object.values(before.chats);
  await disconnect({ repo: gh.repo, agent: chat.id, github: gh, log: () => {} });
  // A crash after the install marker must not act like a project disconnect.
  await write(disabledFile(file), "installing\n");
  const c = await readJSON(file);
  await writeJSON(file, { ...c, installing: true, previousServer: c.server, previousHooks: c.ownedHooks });
  await connect(params);
  assert.deepEqual(await readJSON(stateFile(file)), before);
  now += 61_000;
  await assert.rejects(runtime.hook(input), /retired/);
  assert.equal((await status({ repo: gh.repo, github: gh })).agents[0].active, false);
  // Explicit user-selected reconnection still works.
  await connect({ ...params, agent: chat.id });
  await runtime.hook(input);
  assert.equal((await status({ repo: gh.repo, github: gh })).agents[0].active, true);
});

test("an interrupted explicit project reconnect still resumes its disconnected chats", async (t) => {
  const root = await gitProject(t), dir = await temporary(t);
  process.env.PATCHWORK_HOME = dir;
  t.after(() => delete process.env.PATCHWORK_HOME);
  const gh = new FakeGitHub(), params = {
    cwd: root, client: "codex", repo: gh.repo, github: gh, create: true, log: () => {},
  };
  const { file } = await connect(params);
  const runtime = new Runtime(file, { github: gh });
  const input = { session_id: "saved", hook_event_name: "SessionStart", transcript_path: "/test/transcript.jsonl" };
  await runtime.hook(input);
  const [chat] = Object.values((await readJSON(stateFile(file))).chats);
  await disconnect({ cwd: root, client: "codex", github: gh, log: () => {} });
  const c = await readJSON(file);
  // Reconnect publishes its intent before modifying config or session state.
  await write(disabledFile(file), "installing\n");
  await writeJSON(file, { ...c, enabled: true, installing: true, resumeChats: true, previousServer: c.server, previousHooks: c.ownedHooks });
  await connect(params);
  const [resumed] = Object.values((await readJSON(stateFile(file))).chats);
  assert.equal(resumed.id, chat.id);
  assert.equal(resumed.chat_key, chat.chat_key);
  assert.deepEqual(resumed.seen, chat.seen);
  assert.equal((await readJSON(file)).resumeChats, undefined);
  await runtime.hook(input);
  assert.equal((await status({ repo: gh.repo, github: gh })).agents[0].active, true);
});
