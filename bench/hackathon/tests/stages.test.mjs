import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evidence, usage, stagedTurns, checkpointSeconds, returnSeconds } from "../lib/stages.mjs";
import { CHECK_INTERVAL } from "../../../packages/cli/lib/runtime.js";
import { PROMPT_INTERVAL } from "../../../packages/cli/lib/sync.js";
import { report } from "../lib/report.mjs";

const paths = { receiver: "/b/.codex/hooks.json", sender: "/a/.codex/hooks.json" };
const phases = () => ({ prompt: { marker: "run prompt REQUEST-one", postTurn: "a1", receiveTurn: "b1", returnTurn: "a2", finished: true },
  checkpoint: { marker: "run checkpoint REQUEST-two", postTurn: "a3", receiveTurn: "b2", returnTurn: "a3", finished: true } });
const event = (agent, method, turnId, time, params) => ({ agent, method, timestamp: new Date(time).toISOString(), params: { turnId, ...params } });
const hook = (agent, name, turnId, time, record, commandId) => event(agent, "hook/completed", turnId, time, { run: {
  id: `${name}:0:${paths[agent]}${commandId ? `:${commandId}` : ""}`, eventName: name,
  handlerType: name === "sessionStart" ? "command" : "mcpTool", sourcePath: paths[agent], status: "completed",
  entries: [{ kind: "context", text: typeof record === "string" ? record : JSON.stringify(record) }],
} });
const mcp = (agent, tool, turnId, time, args, result) => event(agent, "item/completed", turnId, time, { item: {
  id: `mcp-${time}`, type: "mcpToolCall", server: "patchwork", tool, status: "completed", arguments: args,
  result: { content: [{ type: "text", text: JSON.stringify(result) }] },
} });
const command = (agent, method, turnId, time, seconds) => event(agent, method, turnId, time, { item: {
  id: `exec-${agent}`, type: "commandExecution", command: `/bin/zsh -lc 'sleep ${seconds}'`, status: "completed", exitCode: 0,
} });
function fixture(p = phases()) {
  return [hook("receiver", "sessionStart", "b0", 1, "Your agent ID: B"), hook("sender", "sessionStart", "a1", 2, "Your agent ID: A"),
    mcp("sender", "post_message", "a1", 10, { kind: "request", body: p.prompt.marker }, { number: 42, id: 100 }),
    hook("receiver", "userPromptSubmit", "b1", 20, { id: "issue:42", body: p.prompt.marker }),
    mcp("receiver", "acknowledge_request", "b1", 30, { request_id: 42, response: "can_handle" }, { id: 901 }),
    hook("sender", "userPromptSubmit", "a2", 40, { id: "comment:901", thread: 42, body: "B: **Can handle**." }),
    command("receiver", "item/started", "b2", 51, checkpointSeconds),
    mcp("sender", "post_message", "a3", 60, { kind: "request", body: p.checkpoint.marker }, { number: 43, id: 101 }),
    command("sender", "item/started", "a3", 61, returnSeconds),
    command("receiver", "item/completed", "b2", 70, checkpointSeconds),
    hook("receiver", "postToolUse", "b2", 71, { id: "issue:43", body: p.checkpoint.marker }, "exec-receiver"),
    mcp("receiver", "acknowledge_request", "b2", 80, { request_id: 43, response: "can_handle" }, { id: 902 }),
    command("sender", "item/completed", "a3", 90, returnSeconds),
    hook("sender", "postToolUse", "a3", 91, { id: "comment:902", thread: 43, body: "B: **Can handle**." }, "exec-sender")];
}
test("PASS requires both distinct native round trips, registrations, IDs, and correlated commands", () => {
  assert(Object.values(evidence(fixture(), phases(), paths).checks).every(Boolean));
  for (const i of [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13]) {
    assert(Object.values(evidence(fixture().filter((_, j) => i !== j), phases(), paths).checks).some(v => !v), `missing event ${i}`);
  }
  const proof = evidence(fixture(), phases(), paths);
  assert.equal(proof.delivery.prompt.messageId, 100);
  assert.equal(proof.delivery.checkpoint.acknowledgmentId, 902);
  assert.equal(proof.delivery.checkpoint.steps.requestDelivery.hook, "postToolUse");
});
test("prompt/startup delivery cannot substitute for tool delivery or a subsequent prompt", () => {
  for (const index of [3, 5, 10, 13]) {
    const es = fixture(); es[index].params.run.eventName = index < 6 ? "postToolUse" : "userPromptSubmit";
    assert(!Object.values(evidence(es, phases(), paths).checks).every(Boolean));
  }
  const es = fixture(); es[0].params.turnId = "b1";
  assert.equal(evidence(es, phases(), paths).checks.promptRoundTrip, false);
});
test("wrong source, turn, IDs, order, failed results, and misleading context never pass", () => {
  const mutate = [
    es => es[3].params.run.sourcePath = "/fake/hooks.json",
    es => es[3].params.turnId = "unrelated",
    es => es[4].params.item.arguments.request_id = 43,
    es => es[5].params.run.entries[0].text = JSON.stringify({id:"comment:9010",thread:42,body:"Can handle"}),
    es => es[10].params.run.entries[0].text = `null\n${JSON.stringify({id:"issue:430",body:phases().checkpoint.marker})}`,
    es => es[4].timestamp = new Date(0).toISOString(),
    es => es[2].params.item.result.isError = true,
    es => es[13].params.run.id = "unrelated-command",
    es => es[12].params.item.exitCode = 1,
  ];
  for (const change of mutate) { const es = fixture(); change(es); assert(!Object.values(evidence(es, phases(), paths).checks).every(Boolean)); }
});
test("post-write prompts, manual reads, repeated checkpoint commands, and substitutions disqualify", () => {
  const additions = [
    event("receiver", "hook/started", "b2", 65, {run:{eventName:"userPromptSubmit"}}),
    event("sender", "item/started", "a3", 85, {item:{type:"userMessage"}}),
    event("receiver", "item/completed", "b2", 70, {item:{type:"mcpToolCall",tool:"read_messages"}}),
    command("receiver", "item/started", "b2", 65, 20),
    {method:"model/rerouted"}, {method:"account/updated",params:{subscriptionVerified:false}},
  ];
  for (const e of additions) assert(!Object.values(evidence([...fixture(),e], phases(), paths).checks).every(Boolean));
});
test("cached tokens count once; per-turn increments survive interleaved sessions and expose missing accounting", () => {
  const sample = (a, t, total, cached) => event(a,"thread/tokenUsage/updated",a+t,t,{tokenUsage:{total:{totalTokens:total,inputTokens:total-10,cachedInputTokens:cached,outputTokens:10}}});
  const stats = usage([sample("receiver",1,15000,11000),sample("sender",2,16000,12000),sample("receiver",3,40000,25000)]);
  assert.equal(stats.totals.totalTokens,56000);
  assert.equal(stats.totals.cachedInputTokens,37000);
  assert.equal(stats.increments[2].delta.totalTokens,25000);
  assert.equal(stats.increments[2].turnId,"receiver3");
  assert.deepEqual(stats.missingAgents,[]);
  assert.deepEqual(usage([]).missingAgents,["receiver","sender"]);
  assert.equal(usage([sample("receiver",1,15000,11000),sample("receiver",2,14000,10000)]).increments[1].delta,null);
});
test("staged driver sends six bounded prompts, waits locally, and never calls a hook or board tool", async () => {
  let clock = 1000, calls = [], authentications = 0;
  const m = {runId:"unit-only",model:"gpt-6-luna",reasoning:"low"};
  const run = {manifest:m,persist:async()=>{}};
  const agents = ["receiver","sender"].map(id=>({id,hooks:paths[id],threadId:id,client:{events:[]}}));
  const [b,a] = agents;
  const put = (agent, es) => agent.client.events.push(...es.map(e=>({...e,timestamp:new Date(clock).toISOString()})));
  const done = (agent,id) => put(agent,[event(agent.id,"turn/completed",id,0,{turn:{id,status:"completed"}})]);
  const ids = ["b0","a1","b1","a2","b2","a3"];
  for(const agent of agents) agent.client.call = async (method, params) => {
    assert.equal(method,"turn/start"); assert.equal(params.model,"gpt-6-luna"); assert.equal(params.effort,"low");
    const id=ids[calls.length]; calls.push({agent:agent.id,prompt:params.input[0].text,at:clock});
    const es=fixture(m.phases);
    if(id==="b0")put(b,[es[0]]);
    if(id==="a1")put(a,[es[1],es[2]]);
    if(id==="b1")put(b,[es[3],es[4]]);
    if(id==="a2")put(a,[es[5]]);
    if(id==="b2")put(b,[es[6]]);
    if(id==="a3") {
      put(a,[es[7],es[8]]); clock += returnSeconds*1000;
      put(b,[es[9],es[10],es[11]]); put(a,[es[12],es[13]]); done(b,"b2");
    }
    if(id!=="b2")done(agent,id);
    return {turn:{id}};
  };
  await stagedTurns(run,agents,300000,()=>{}, {now:()=>clock,wait:async ms=>{clock+=ms;},authenticate:async()=>{authentications++;}});
  assert.equal(calls.length,6); assert.equal(authentications,6);
  assert(calls[2].at-calls[0].at>=PROMPT_INTERVAL);
  assert(calls[3].at-calls[1].at>=PROMPT_INTERVAL);
  assert(calls.filter(c=>c.agent==="receiver").every(c=>!c.prompt.includes("REQUEST-")));
  assert(calls[3].prompt.includes("No tools."));
  assert(checkpointSeconds*1000>CHECK_INTERVAL);
  assert(m.evidence.promptRoundTrip && m.evidence.checkpointRoundTrip);
});
test("budget/auth failures prevent further model starts; short limits do not create an implicit retry", async () => {
  const run={manifest:{runId:"unit",model:"gpt-6-luna",reasoning:"low"},persist:async()=>{}};
  let calls=0;
  const agents=["receiver","sender"].map(id=>({id,hooks:paths[id],client:{events:[],call:async()=>{calls++;}}}));
  await assert.rejects(stagedTurns(run,agents,0,()=>{},{now:()=>1}),/runtime budget/);
  await assert.rejects(stagedTurns(run,agents,10,()=>{},{now:()=>1,authenticate:async()=>{throw new Error("auth refused");}}),/auth refused/);
  await assert.rejects(stagedTurns(run,agents,10,()=>{throw new Error("token budget");},{now:()=>1}),/token budget/);
  assert.equal(calls,0);
});
test("a completed turn with no MCP request stops the sequence before another receiving prompt", async () => {
  const m={runId:"unit",model:"gpt-6-luna",reasoning:"low"},run={manifest:m,persist:async()=>{}};
  let calls=0;
  const agents=["receiver","sender"].map(id=>({id,hooks:paths[id],threadId:id,client:{events:[]}}));
  for(const a of agents)a.client.call=async()=>{
    calls++; const id=calls===1?"b0":"a1";
    a.client.events.push(hook(a.id,"sessionStart",id,1,"Your agent ID: fixture"),event(a.id,"turn/completed",id,2,{turn:{id,status:"completed"}}));
    return {turn:{id}};
  };
  await assert.rejects(stagedTurns(run,agents,10,()=>{},{now:()=>1,authenticate:async()=>{}}),/no further model turn/);
  assert.equal(calls,2);
  assert.equal(m.phases.prompt.finished,true);
});
test("reports distinguish prompt-only success from incomplete checkpoint delivery and include costs/timing", async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"sim-report-")); t.after(()=>rm(dir,{recursive:true,force:true}));
  const p=phases(); p.checkpoint.finished=false;
  const proof=evidence(fixture().slice(0,6),p,paths);
  const m={runId:"fixture",repo:"example/test",status:"INCONCLUSIVE",evidence:proof.checks,delivery:proof.delivery,
    agents:[],stages:[],cleanup:{complete:true,errors:[]},limitations:[],tokenBudget:100000,
    startedAt:new Date(0).toISOString(),finishedAt:new Date(60000).toISOString(),usage:{totals:{totalTokens:111577,inputTokens:111181,cachedInputTokens:89600,outputTokens:396},missingAgents:[]}};
  const file=await report({dir,manifest:m}); const text=await readFile(file,"utf8");
  assert.match(text,/UserPromptSubmit: PASS/); assert.match(text,/PostToolUse.*NOT VERIFIED/);
  assert.match(text,/60.000 seconds/); assert.match(text,/111577/); assert.match(text,/overshoot: 11577/);
  assert.match(text,/Phase 0 complete: no/);
});
