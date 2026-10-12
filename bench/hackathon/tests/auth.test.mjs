import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify } from "smol-toml";
import { subscriptionAuth, subscriptionConfig, subscriptionEnvironment, sourceAuthentication, agentAuthentication, codexAuthentication, subscriptionAccount, AUTH_CONFIG, MCP_ENV } from "../lib/auth.mjs";
import { save, redact } from "../lib/common.mjs";
import { hookConfiguration, serverConfiguration } from "../../../packages/cli/lib/connections.js";
import { agentEnvironment } from "../lib/environment.mjs";

const auth = () => ({auth_mode:"chatgpt",OPENAI_API_KEY:null,tokens:{access_token:"fixture-access-secret",refresh_token:"fixture-refresh-secret",id_token:"fixture-id-secret",account_id:"fixture-account"}});
const text = () => JSON.stringify(auth());
test("subscription auth rejects API keys, mixed credentials, unknown modes, and missing tokens", () => {
  assert.equal(subscriptionAuth(text()).auth_mode,"chatgpt");
  for(const value of [null,{}, {...auth(),auth_mode:"apikey"}, {...auth(),auth_mode:"chatgptAuthTokens"}, {...auth(),auth_mode:"unknown"},
    {...auth(),OPENAI_API_KEY:"fixture-private-api-key"}, {...auth(),CODEX_API_KEY:"fixture-private-api-key"}, {...auth(),tokens:{}}, {...auth(),tokens:{...auth().tokens,refresh_token:null}}]) {
    assert.throws(()=>subscriptionAuth(JSON.stringify(value)), e=>/Subscription authentication/.test(e.message)&&!e.message.includes("fixture-private"));
  }
  assert.throws(()=>subscriptionAuth('{"OPENAI_API_KEY":"never-echo-this-malformed-secret'),e=>!e.message.includes("never-echo"));
  assert(!redact(auth()).includes("fixture-access-secret"));
});
test("provider, keyring, endpoint, login, and profile overrides fail closed", () => {
  subscriptionConfig({}); subscriptionConfig(AUTH_CONFIG,true);
  for(const config of [{model_provider:"azure"},{model_provider:"unknown"},{model_providers:{openai:{base_url:"https://example.invalid"}}},
    {forced_login_method:"api"},{cli_auth_credentials_store:"keyring"},{chatgpt_base_url:"https://example.invalid"},{openai_base_url:"https://example.invalid"},
    {profiles:{alternate:{model_provider:"ollama"}}},{profile:"alternate"},{experimental_bearer_token:"private"}]) assert.throws(()=>subscriptionConfig(config),/Subscription authentication/);
  assert.throws(()=>subscriptionConfig({},true),/isolated auth policy/);
});
test("OpenAI/Codex authentication environment overrides are refused; GitHub stays separate", () => {
  const a={codex:"/agent/home/.codex",env:{HOME:"/agent/home",CODEX_HOME:"/agent/home/.codex",GH_TOKEN:"github-only"}};
  subscriptionEnvironment(a);
  for(const key of ["OPENAI_API_KEY","CODEX_API_KEY","OPENAI_BASE_URL","CODEX_ACCESS_TOKEN"]) {
    assert.throws(()=>subscriptionEnvironment({...a,env:{...a.env,[key]:""}}),/isolated environment/);
  }
  assert.throws(()=>subscriptionEnvironment({...a,env:{...a.env,CODEX_HOME:"/other"}}));
});
test("actual environment builder never inherits caller API credentials or provider overrides", () => {
  const names=["OPENAI_API_KEY","CODEX_API_KEY","OPENAI_BASE_URL","CODEX_ACCESS_TOKEN"];
  const before=names.map(k=>process.env[k]);
  try {
    for(const k of names)process.env[k]="parent-only-private-credential";
    const env=agentEnvironment("/private/agent", "github-is-separate");
    assert.equal(env.GH_TOKEN,"github-is-separate");
    for(const k of names)assert(!Object.hasOwn(env,k));
    assert(!JSON.stringify(env).includes("parent-only-private-credential"));
  } finally { names.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];}); }
});
test("source and isolated credentials/configs are checked independently, without secret errors", async t => {
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),"sim-auth-")));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const a={codex:path.join(dir,"home/.codex"),work:path.join(dir,"project"),entry:"/runtime/patchwork.js",connection:path.join(dir,"connection.json")};
  a.hooks=path.join(a.work,".codex/hooks.json"); a.env={HOME:path.dirname(a.codex),CODEX_HOME:a.codex,GH_TOKEN:"github-only"};
  await assert.rejects(sourceAuthentication(a.codex),/source auth file/);
  await save(path.join(a.codex,"auth.json"),auth());
  await writeFile(path.join(a.codex,"config.toml"),stringify(AUTH_CONFIG));
  await save(a.hooks,hookConfiguration(a.entry,a.connection));
  const project=path.join(a.work,".codex/config.toml");
  await writeFile(project,stringify({mcp_servers:{patchwork:{...serverConfiguration(a.entry,a.connection),env_vars:MCP_ENV}}}));
  await agentAuthentication(a,await sourceAuthentication(a.codex));
  await save(path.join(a.codex,"auth.json"),{...auth(),OPENAI_API_KEY:"fixture-private-api-key"});
  await assert.rejects(agentAuthentication(a,text()),/not exclusively ChatGPT/);
  await save(path.join(a.codex,"auth.json"),{...auth(),tokens:{...auth().tokens,id_token:"different-account"}});
  await assert.rejects(agentAuthentication(a,text()),/account differs/);
  await save(path.join(a.codex,"auth.json"),auth());
  await writeFile(project,'model_provider="azure"');
  await assert.rejects(agentAuthentication(a,text()),/override/);
  await writeFile(path.join(a.codex,"config.toml"),'model_provider="azure"');
  await assert.rejects(sourceAuthentication(a.codex),/override/);
});
test("Codex must report a ChatGPT account and effective subscription policy before a turn", async () => {
  for(const type of [undefined,"apiKey","amazonBedrock","unknown","chatgptAuthTokens"]) assert.throws(()=>subscriptionAccount({account:{type},requiresOpenaiAuth:true}));
  assert.throws(()=>subscriptionAccount({account:{type:"chatgpt"},requiresOpenaiAuth:false}));
  const calls=[];
  const client={call:async(method,args)=>{calls.push({method,args});return method==='account/read'?{account:{type:"chatgpt",email:"never-log@example.invalid"},requiresOpenaiAuth:true}:{config:AUTH_CONFIG};}};
  assert.deepEqual(await codexAuthentication(client,{work:"/agent/project"}),{mode:"chatgpt",verified:true});
  assert.deepEqual(calls.map(c=>c.method),["account/read","config/read"]);
  assert.equal(calls[0].args.refreshToken,false);
  await assert.rejects(codexAuthentication({call:async()=>{throw new Error("fixture-access-secret");}},{work:"/a"}),e=>!e.message.includes("fixture-access-secret"));
});
