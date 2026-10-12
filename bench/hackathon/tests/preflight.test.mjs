import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorize, repoName, runId, redact, secret, save, ownedDirectory, command, newRun, json, delay } from "../lib/common.mjs";
import { Codex } from "../lib/codex.mjs";
import { parse } from "smol-toml";
import { seatbelt, mcpEnvironment } from "../lib/environment.mjs";
import { mergeCodex } from "../../../packages/cli/lib/config.js";
import { serverConfiguration } from "../../../packages/cli/lib/connections.js";
import { preflight, cleanup, cleanupRequests, validateRepo, ownedRequest } from "../lib/preflight.mjs";
import { marked } from "../../../packages/cli/lib/board.js";

test("live operations require explicit repository AND paid/write opt-in", () => {
  assert.throws(() => authorize({}), /allow-live/);
  assert.throws(() => authorize({ "allow-live": true }), /sandbox-repo/);
  authorize({ "allow-live": true, "sandbox-repo": true });
  for (const r of [undefined, "", "../secret", "owner/..", "https://github.com/owner/repo", "owner/repo;rm"]) assert.throws(() => repoName(r));
  assert.equal(repoName("example/sandbox"), "example/sandbox");
});
test("run selectors cannot traverse outside the output directory", () => {
  for (const id of ["../secrets", "/tmp", "sim-x", "sim-2026/../00000000"]) assert.throws(() => runId(id));
  runId("sim-2026-10-12T00-00-00-000Z-1234abcd");
});
test("cleanup requires a matching ownership marker and refuses symlinks", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "sim-unit-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await save(path.join(base, "owned/.patchwork-sim-owner.json"), { runId: "mine" });
  await ownedDirectory(path.join(base, "owned"), "mine");
  await assert.rejects(ownedDirectory(path.join(base, "owned"), "not-mine"), /mismatch/);
  await symlink(path.join(base, "owned"), path.join(base, "link"));
  await assert.rejects(ownedDirectory(path.join(base, "link"), "mine"), /linked/);
});
test("credentials and private chat keys are removed from persisted events", () => {
  secret("private-long-lived-credential");
  const s = redact({ token: "private-long-lived-credential", api: "ghp_123456789", chat_key: "12345678-abcd-1234-abcd-123456789012" });
  assert(!s.includes("private-long-lived-credential"));
  assert(!s.includes("ghp_123456789"));
  assert(!s.includes("12345678-abcd-1234-abcd-123456789012"));
  assert.doesNotThrow(() => JSON.parse(s));
});
test("request recovery requires run tags, verified owner/chat, and a newly created issue", () => {
  const m = {runId:"sim-unit",initialIssueIds:[5],repository:{userId:10}};
  const owned = new Set(["00000000-0000-4000-8000-000000000001"]);
  const issue = {id:6,number:42,user:{id:10},title:"sim-unit native request",body:marked("sim-unit REQUEST",{type:"request",agent_id:[...owned][0],owner_id:10})};
  assert(ownedRequest(issue,m,owned));
  assert(!ownedRequest({...issue,id:5},m,owned));
  assert(!ownedRequest({...issue,user:{id:11}},m,owned));
  assert(!ownedRequest({...issue,body:"sim-unit REQUEST"},m,owned));
  assert(!ownedRequest({...issue,title:"unrelated"},m,owned));
  assert(!ownedRequest(issue,m,new Set()));
});
test("request cleanup recovers a lost response, leaves unrelated issues alone, and retries safely", async t => {
  const output=await realpath(await mkdtemp(path.join(os.tmpdir(),"sim-request-cleanup-")));
  t.after(()=>rm(output,{recursive:true,force:true}));
  const run=await newRun({repo:"example/sandbox",output});
  const m=run.manifest, id="00000000-0000-4000-8000-000000000001";
  m.repository={userId:10}; m.initialIssueIds=[1];
  const issue={id:2,number:42,state:"open",user:{id:10},title:m.runId,body:marked(m.runId,{type:"request",agent_id:id,owner_id:10})};
  let writes=0, fail=true;
  const api={list:async(repo,endpoint)=>endpoint==='issues?state=all'?[{...issue,id:1,number:41},issue,{...issue,id:3,number:43,user:{id:99}}]:[],
    github:async(repo,endpoint,options)=>{assert.equal(endpoint,'issues/42');if(options?.method==='PATCH'){writes++;issue.state='closed';if(fail){fail=false;throw new Error('Response lost');}}return issue;}};
  await assert.rejects(cleanupRequests(run,new Set([id]),api),/Response lost/);
  assert(m.resources.some(r=>r.type==='request'&&r.number===42));
  await cleanupRequests(run,new Set([id]),api);
  await cleanupRequests(run,new Set([id]),api);
  assert.equal(writes,1);
  assert.deepEqual(m.closedRequests,[42]);
  assert.equal(m.resources.filter(r=>r.type==='request').length,1);
});
test("macOS profile blocks other homes and temporary environments; writes restricted", () => {
  const policy = seatbelt("/private/tmp/run/a", "/private/tmp/run/runtime");
  assert(policy.includes('(deny file-write*)'));
  assert(policy.includes('(subpath "/Users")'));
  assert(policy.includes('(subpath "/private/tmp")'));
  assert(policy.includes('(subpath "/private/tmp/run/a")'));
  assert(!policy.includes('(subpath "/private/tmp/run")'));
});
test("isolated MCP receives named environment variables without storing credentials or altering tools", () => {
  const desired = serverConfiguration("/runtime/patchwork.js", "/agent/connection.json");
  const original = mergeCodex('[mcp_servers.other]\ncommand="other-tool"\n', desired);
  const config = mcpEnvironment(original);
  const parsed = parse(config);
  assert.deepEqual({ ...parsed.mcp_servers.other }, { command: "other-tool" });
  const { env_vars, ...server } = parsed.mcp_servers.patchwork;
  assert.deepEqual(server, desired);
  assert.deepEqual(env_vars, ["GH_TOKEN", "GH_CONFIG_DIR", "PATCHWORK_HOME", "TMPDIR"]);
  assert.equal(mcpEnvironment(config), config);
  assert.equal(parsed.mcp_servers.patchwork.env, undefined);
  assert.throws(() => mcpEnvironment(""), /Install Patchwork/);
});
test("real subprocess protocol client correlates replies, handles crashes, and redacts logs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sim-protocol-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = `const rl=require('readline').createInterface({input:process.stdin}); rl.on('line',l=>{const m=JSON.parse(l); if(m.method==='crash')process.exit(9); if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{ok:m.method}})+'\\n');});`;
  const c = new Codex({ command: process.execPath, args: ["-e", mock], cwd: dir, env: process.env, log: path.join(dir, "events.jsonl"), agent: "fixture", runId: "unit-only" });
  t.after(() => c.stop());
  const answers = await Promise.all([c.call("one", {}), c.call("two", {})]);
  assert.deepEqual(answers, [{ ok: "one" }, { ok: "two" }]);
  await assert.rejects(c.call("crash", {}), /exited/);
  await c.stop();
  assert.equal(c.exit.code, 9);
  const log = await readFile(path.join(dir, "events.jsonl"), "utf8");
  assert(log.includes("process/exit"));
  assert(!log.includes('"ok":"one"')); // arbitrary RPC responses aren't logged
});
test("CLI rejects live runs without authorization before accessing tools", async () => {
  await assert.rejects(command(process.execPath, [path.resolve(import.meta.dirname, "../cli.mjs"), "preflight", "--repo", "example/sandbox"]), /allow-live/);
  await assert.rejects(preflight({repo:"example/sandbox"}),/allow-live/);
});
test("invalid budgets and source repository are rejected before mutation", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "sim-budget-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(newRun({ output: path.join(dir, "not-created"), seconds: "Infinity" }), /30–300/);
  await assert.rejects(readFile(path.join(dir, "not-created/manifest.json")), { code: "ENOENT" });
  await assert.rejects(newRun({ output: path.join(dir, "not-created"), tokens: "NaN" }), /tokens/);
  const pkg = await json(path.resolve(import.meta.dirname, "../../../packages/cli/package.json"));
  const source = pkg.repository.url.match(/github\.com\/([^/]+\/[^/]+?)\.git$/)[1];
  await assert.rejects(validateRepo(source), /source repository/);
});
test("failed cleanup preserves unknown files and prevents another experiment", async (t) => {
  const output = await realpath(await mkdtemp(path.join(os.tmpdir(), "sim-recovery-")));
  t.after(() => rm(output, { recursive: true, force: true }));
  const run = await newRun({ repo: "example/sandbox", output });
  const protectedDir = path.join(output, "unrelated");
  await save(path.join(protectedDir, ".patchwork-sim-owner.json"), { runId: "someone-else" });
  run.manifest.temp = protectedDir;
  await cleanup(run);
  assert.equal(run.manifest.cleanup.complete, false);
  assert.match(run.manifest.cleanup.errors.join(" "), /ownership marker mismatch/);
  assert.equal((await json(path.join(protectedDir, ".patchwork-sim-owner.json"))).runId, "someone-else");
  await assert.rejects(command(process.execPath, [path.resolve(import.meta.dirname, "../cli.mjs"), "preflight", "--repo", "example/sandbox", "--sandbox-repo", "--allow-live", "--output", output]), /Unfinished cleanup/);
});
test("reset is repeatable after successful local cleanup, preserving reports", async (t) => {
  const output = await realpath(await mkdtemp(path.join(os.tmpdir(), "sim-reset-")));
  t.after(() => rm(output, { recursive: true, force: true }));
  const run = await newRun({ repo: "example/sandbox", output });
  run.manifest.temp = path.join(output, "operational");
  await save(path.join(run.manifest.temp, ".patchwork-sim-owner.json"), { runId: run.manifest.runId });
  await cleanup(run);
  await cleanup(run);
  assert(run.manifest.cleanup.complete);
  assert.equal((await json(path.join(run.dir, "manifest.json"))).runId, run.manifest.runId);
});
test("a protocol timeout discards pending requests; later requests still work", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sim-timeout-"));
  const mock = `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l); if(m.method==='hang')return; process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n')});`;
  const c = new Codex({ command: process.execPath, args: ["-e", mock], cwd: dir, env: process.env, log: path.join(dir, "events.jsonl"), agent: "fixture", runId: "unit-only" });
  t.after(async () => { await c.stop(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(c.call("hang", {}, 30), /timed out/);
  assert.equal(c.pending.size, 0);
  assert.deepEqual(await c.call("working", {}), { ok: true });
});
test("free local verification cannot submit model turns or change authentication", async () => {
  const client=Object.create(Codex.prototype);
  client.setupOnly=true;
  for(const method of ["turn/start","turn/steer","review/start","account/login/start","config/value/write","thread/compact/start"]) {
    await assert.rejects(client.call(method,{}),/Local verification cannot/);
  }
});
test("stopping a session also kills an uncooperative child after its parent exits", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sim-descendant-"));
  const heartbeat = path.join(dir, "heartbeat");
  const descendant = `const fs=require('fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(heartbeat)},'x'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),25); process.send({ready:true}); process.disconnect();`;
  const parent = `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.stdout.write(JSON.stringify({id:m.id,result:{pid:child.pid}})+'\\n'));});`;
  const c = new Codex({ command: process.execPath, args: ["-e", parent], cwd: dir, env: process.env, log: path.join(dir, "events.jsonl"), agent: "fixture", runId: "unit-only" });
  let pid;
  t.after(async () => {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    await c.stop();
    await rm(dir, { recursive: true, force: true });
  });
  ({ pid } = await c.call("start", {}));
  const stopping = c.stop();
  assert.equal(c.stop(), stopping);
  await stopping;
  const events = (await readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.method === "runner/stop").length, 1);
  assert(events.findIndex(e => e.method === "runner/stop") < events.findIndex(e => e.method === "process/exit"));
  await delay(50);
  const last = await readFile(heartbeat, "utf8");
  await delay(100);
  assert.equal(await readFile(heartbeat, "utf8"), last);
});
