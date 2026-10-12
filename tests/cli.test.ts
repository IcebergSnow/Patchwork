import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
const parse = (text: string, options = {integersAsBigInt:false}): any => parseToml(text, options);
import { mergeConfig, mergeHooks } from '../packages/cli/lib/config.js';
import { connect, serverURL, verifyConnection } from '../packages/cli/lib/connect.js';
import { hookConfiguration } from '../src/connections';

const server = 'https://board.example', token = `pw_a_${'a'.repeat(64)}`;
const unrelated = {type:'command', command:'echo keep', timeout:12};

test('TOML merge preserves other servers, settings, comments, and repeats without changes', () => {
  const original = '# My settings\nmodel = "custom-model"\n[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"]\n';
  const output = mergeConfig(original, server, token);
  assert.ok(output.startsWith(original));
  const parsed = parse(output);
  assert.equal(parsed.model, 'custom-model');
  assert.deepEqual({...parsed.mcp_servers.other}, {command:'node',args:['other.js']});
  assert.equal(parsed.mcp_servers.patchwork.http_headers.Authorization, `Bearer ${token}`);
  assert.equal(mergeConfig(output, server, token), output);
  assert.throws(() => mergeConfig(output, 'https://other.example', token), /different Patchwork/);
  assert.throws(() => mergeConfig('private = "unterminated secret', server, token), e => !String(e).includes('unterminated secret'));
});

test('inline TOML tables and explicit re-pair retain unrelated values and other headers', () => {
  const output = mergeConfig('mcp_servers = {other = {command = "node"}}\nfloat = 1.0\nbig = 9223372036854775807\n', server, token);
  assert.deepEqual({...parse(output, {integersAsBigInt:true}).mcp_servers.other}, {command:'node'});
  assert.match(output, /float = 1\.0/);
  assert.match(output, /9223372036854775807/);
  const changed = mergeConfig(output, 'https://new.example', token, true);
  assert.equal(parse(changed, {integersAsBigInt:true}).mcp_servers.patchwork.url, 'https://new.example/mcp');
  const manual = '[mcp_servers.patchwork]\nurl="https://old.example/mcp"\nbearer_token_env_var="OLD_TOKEN"\nhttp_headers={Extra="keep"}\ntool_timeout_sec=20\n';
  const merged = parse(mergeConfig(manual, server, token, true)).mcp_servers.patchwork;
  assert.equal(merged.bearer_token_env_var, undefined);
  assert.equal(merged.http_headers.Extra, 'keep');
  assert.equal(merged.tool_timeout_sec, 20);
});

test('hook merge preserves unrelated handlers and metadata, deduplicates board checks, and refuses malformed sources', () => {
  const boardHook = hookConfiguration().hooks.SessionStart[0].hooks[0];
  const old = JSON.stringify({description:'Keep this', hooks:{SessionStart:[{matcher:'startup', hooks:[unrelated,boardHook]},{hooks:[boardHook]}],Stop:[{hooks:[unrelated]}]}});
  const output = mergeHooks(old), result = JSON.parse(output);
  assert.equal(result.description, 'Keep this');
  assert.deepEqual(result.hooks.Stop, [{hooks:[unrelated]}]);
  assert.deepEqual(result.hooks.SessionStart[0], {matcher:'startup',hooks:[unrelated]});
  for (const event of ['SessionStart','UserPromptSubmit','PostToolUse']) assert.equal(result.hooks[event].flatMap((g:any)=>g.hooks).filter((h:any)=>h.server==='patchwork').length, 1);
  assert.equal(mergeHooks(output), output);
  assert.throws(() => mergeHooks('{bad json secret'), e => !String(e).includes('json secret'));
  assert.throws(() => mergeHooks('{"hooks":{"SessionStart":{}}}'), /Invalid/);
  assert.throws(() => mergeHooks('{}', {SessionStart:[{hooks:[boardHook]}]}), /inline/);
});

test('server validation rejects insecure remote URLs and embedded credentials', () => {
  for (const url of ['http://board.example','https://user:secret@board.example','https://board.example/path','https://board.example/?token=secret','https://board.example/#secret','file:///tmp/test']) assert.throws(() => serverURL(url), e => !String(e).includes('secret'));
  assert.equal(serverURL('https://board.example/'), server);
  assert.equal(serverURL('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});

async function project(t:TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'patchwork-cli-'));
  t.after(() => rm(cwd, {recursive:true,force:true}));
  execFileSync('git', ['init','--quiet',cwd]);
  await mkdir(path.join(cwd,'.codex'));
  const file = (name:string) => path.join(cwd,'.codex',name);
  return {cwd,file};
}
function network(t:TestContext, options: {failVerify?:boolean} = {}) {
  let redemptions = 0;
  const requests: {url:string;init:RequestInit}[] = [];
  const mock = t.mock.method(globalThis, 'fetch', async (url:any, init:any) => {
    requests.push({url,init});
    if (url.endsWith('/api/pairing/redeem')) { redemptions++; return Response.json({id:'agent-id',roomId:'room-id',token}); }
    if (options.failVerify) return new Response('secret from server', {status:503});
    const body = JSON.parse(init.body);
    return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{serverInfo:{name:'patchwork'}}:{tools:['check_board','read_messages','post_message'].map(name=>({name}))}});
  });
  return {requests, get redemptions(){return redemptions;}, mock};
}

test('fresh install and repeats use one identity, keep secrets ignored, preserve files and verify authenticated MCP', async t => {
  const {cwd,file} = await project(t), api = network(t), logs:string[] = [];
  await writeFile(file('config.toml'), 'model = "keep"\n');
  await writeFile(file('hooks.json'), JSON.stringify({hooks:{Stop:[{hooks:[unrelated]}]}}));
  const options = {cwd,server,log:(line:string)=>logs.push(line),pairingCode:async()=> 'AAAAA-BBBBB-CCCCC-DDDDD'};
  await connect(options);
  const config = await readFile(file('config.toml'),'utf8'), hooks = await readFile(file('hooks.json'),'utf8');
  await connect({...options,pairingCode:async()=>{throw new Error('Must reuse credentials');}});
  assert.equal(api.redemptions, 1);
  assert.equal(await readFile(file('config.toml'),'utf8'), config);
  assert.equal(await readFile(file('hooks.json'),'utf8'), hooks);
  assert.equal(parse(config).model, 'keep');
  assert.deepEqual(JSON.parse(hooks).hooks.Stop, [{hooks:[unrelated]}]);
  assert.ok(!logs.join('\n').includes(token));
  assert.ok(!logs.join('\n').includes('AAAAA'));
  assert.match(logs.join('\n'), /Restart Codex/);
  assert.match(execFileSync('git',['-C',cwd,'check-ignore','.codex/config.toml','.codex/patchwork.json'],{encoding:'utf8'}), /patchwork.json/);
  const untracked = execFileSync('git',['-C',cwd,'ls-files','--others','--exclude-standard'],{encoding:'utf8'});
  assert.ok(!untracked.includes('config.toml')&&!untracked.includes('patchwork.json'));
  assert.ok(api.requests.every(r=>r.init.redirect==='error'));
  assert.ok(api.requests.filter(r=>r.url.endsWith('/mcp')).every(r=>(r.init.headers as Record<string,string>).Authorization===`Bearer ${token}`));
  if (process.platform !== 'win32') for (const name of ['config.toml','patchwork.json']) assert.equal((await stat(file(name))).mode & 0o777, 0o600);
});

test('failure after redemption is recoverable without consuming another pairing code', async t => {
  const {cwd,file} = await project(t), behavior = {failVerify:true}, api = network(t,behavior);
  const options = {cwd,server,log:()=>{},pairingCode:async()=> 'AAAAA-BBBBB-CCCCC-DDDDD'};
  await assert.rejects(connect(options), e=>!String(e).includes('secret from server'));
  assert.ok((await readFile(file('patchwork.json'),'utf8')).includes(token));
  behavior.failVerify = false;
  await connect({...options,pairingCode:async()=>{throw new Error('Must reuse saved credentials');}});
  assert.equal(api.redemptions, 1);
  assert.match(await readFile(file('config.toml'),'utf8'), /mcp_servers.patchwork/);
});

test('interrupted explicit replacement can resume without another agent, while concurrent edits are preserved', async t => {
  const {cwd,file} = await project(t), behavior = {failVerify:true}, api = network(t,behavior);
  const previous = mergeConfig('model="keep"\n', server, `pw_a_${'b'.repeat(64)}`);
  await writeFile(file('config.toml'), previous);
  const options = {cwd,server,log:()=>{},pairingCode:async()=> 'AAAAA-BBBBB-CCCCC-DDDDD'};
  await assert.rejects(connect({...options,rePair:true}));
  assert.equal(await readFile(file('config.toml'),'utf8'), previous);
  behavior.failVerify = false;
  await connect({...options,pairingCode:async()=>{throw new Error('Must resume saved replacement');}});
  assert.equal(api.redemptions, 1);
  assert.equal(parse(await readFile(file('config.toml'),'utf8')).mcp_servers.patchwork.http_headers.Authorization, `Bearer ${token}`);
  const concurrent = '# Edited during installation\n' + previous;
  await assert.rejects(connect({...options,rePair:true,pairingCode:async()=>{await writeFile(file('config.toml'),concurrent);return 'AAAAA-BBBBB-CCCCC-DDDDD';}}), /changed during installation/);
  assert.equal(await readFile(file('config.toml'),'utf8'), concurrent);
});

test('MCP verification accepts bounded SSE replies and rejects redirects without leaking response content', async t => {
  t.mock.method(globalThis, 'fetch', async (_url:any, init:any) => {
    const body = JSON.parse(init.body);
    const result = body.method === 'initialize' ? {serverInfo:{name:'patchwork'}} : {tools:['check_board','read_messages','post_message'].map(name=>({name}))};
    const encoded = new TextEncoder().encode(`event: message\r\ndata: ${JSON.stringify({id:body.id,result})}\r\n\r\n`);
    return new Response(new ReadableStream({start(controller){controller.enqueue(encoded.slice(0,30));controller.enqueue(encoded.slice(30));}}), {headers:{'Content-Type':'text/event-stream'}});
  });
  await verifyConnection(server, token);
  t.mock.method(globalThis, 'fetch', async()=>{throw new TypeError(`redirect ${token}`);});
  await assert.rejects(verifyConnection(server,token), e=>/securely/.test(String(e))&&!String(e).includes(token));
});

test('tracked credentials and invalid config stop installation before pairing', async t => {
  const {cwd,file} = await project(t), api = network(t);
  const options = {cwd,server,log:()=>{},pairingCode:async()=>{throw new Error('Must not prompt');}};
  await writeFile(file('config.toml'), 'model="keep"\n');
  execFileSync('git',['-C',cwd,'add','.codex/config.toml']);
  await assert.rejects(connect(options), /tracked by Git/);
  assert.equal(await readFile(file('config.toml'),'utf8'), 'model="keep"\n');
  execFileSync('git',['-C',cwd,'rm','--cached','.codex/config.toml']);
  await writeFile(file('hooks.json'), '{invalid');
  await assert.rejects(connect(options), /Cannot parse/);
  assert.equal(api.redemptions, 0);
});

test('existing manual connections are adopted without pairing; redirects and error bodies are never exposed', async t => {
  const {cwd,file} = await project(t), api = network(t);
  await writeFile(file('config.toml'), mergeConfig('',server,token));
  const options = {cwd,server,log:()=>{},pairingCode:async()=>{throw new Error('Must adopt existing connection');}};
  await connect(options);
  assert.equal(api.redemptions, 0);
  api.mock.mock.mockImplementation(async()=>new Response(token,{status:401}));
  await assert.rejects(connect(options), e=>/revoked/.test(String(e))&&!String(e).includes(token));
});

test('symlinked config is refused and executable help needs no network or credentials', async t => {
  const {cwd,file} = await project(t);
  if (process.platform !== 'win32') {
    await writeFile(path.join(cwd,'outside'),'keep');
    await symlink(path.join(cwd,'outside'),file('config.toml'));
    await assert.rejects(connect({cwd,server,log:()=>{},pairingCode:async()=>''}), /linked/);
    assert.equal(await readFile(path.join(cwd,'outside'),'utf8'),'keep');
  }
  const help = execFileSync(process.execPath,['packages/cli/bin/patchwork.js','--help'],{encoding:'utf8'});
  assert.match(help,/Usage: patchwork connect --server/);
});
