import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.env.PATCHWORK_BASE_URL || 'http://127.0.0.1:8787');
if (!['localhost','127.0.0.1','[::1]'].includes(base.hostname)) throw new Error('Smoke tests create fixtures. Use a local preview.');
async function request(path: string, method='GET', data?: unknown, token?: string) {
  const response=await fetch(new URL(path,base),{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:response.status,body:await response.json() as any};
}
const health=await request('/health');assert.equal(health.status,200);
const page=await fetch(base);
assert.equal(page.status,200);
assert.ok(page.headers.get('Content-Security-Policy')?.includes("script-src 'self'"),'Static pages must receive the content security policy');
assert.equal(page.headers.get('X-Content-Type-Options'),'nosniff');
const created=await request('/api/rooms','POST',{name:'Integration smoke test',memberName:'Smoke owner',creationKey:process.env.ROOM_CREATION_KEY});
assert.equal(created.status,201,JSON.stringify(created.body));
const member=created.body.token;
const connection=await request('/api/agents','POST',{name:'Smoke agent',client:'codex',scope:'integration tests'},member);
assert.equal(connection.status,201);
const agent=connection.body.token;
assert.equal((await request('/api/board','GET',undefined,agent)).status,401,'Agent token must not grant browser administration');
await request('/api/room','PATCH',{mergerId:connection.body.id},member);
const client=new Client({name:'patchwork-smoke',version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:`Bearer ${agent}`}}}));
try {
  const tools=await client.listTools();
  assert.equal(tools.tools.length,6);
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await client.callTool({name,arguments:args});
    assert.ok(!result.isError,JSON.stringify(result));
    return JSON.parse((result.content as {type:string;text:string}[])[0].text);
  };
  await call('report_status',{status:'working',branch:'codex/smoke',headCommit:'a123456',baseCommit:'b123456',summary:'Verifying MCP'});
  const posted=await call('post_message',{body:'Need a test endpoint',kind:'request'});
  await call('claim_request',{request_id:posted.id});
  await call('post_message',{body:'Available at commit a123456',kind:'ready',replyTo:posted.id});
  await call('resolve_request',{request_id:posted.id});
  await call('report_integration',{commit:'a123456',status:'passed',summary:'Local HTTP and MCP checks passed.'});
  const feed=await call('read_messages',{after_id:0,limit:100});
  assert.ok(feed.messages.length>=5);assert.equal(feed.openRequests.length,0);
  const board=await request('/api/board','GET',undefined,member);
  assert.equal(board.body.integration.status,'passed');
  assert.ok(board.body.agents[0].last_seen_at);
  assert.ok(!JSON.stringify(board.body).includes(agent));
  const forbidden=await fetch(new URL('/api/board',base),{headers:{Authorization:`Bearer ${member}`,Origin:'https://unrelated.example'}});
  assert.equal(forbidden.status,403);
  const invalid=await fetch(new URL('/api/messages',base),{method:'POST',headers:{Authorization:`Bearer ${member}`,'Content-Type':'application/json'},body:'{invalid'});
  assert.equal(invalid.status,400);
  const oversized=await fetch(new URL('/api/messages',base),{method:'POST',headers:{Authorization:`Bearer ${member}`,'Content-Type':'application/json'},body:JSON.stringify({body:'x'.repeat(70000)})});
  assert.equal(oversized.status,413);
  await request(`/api/agents/${connection.body.id}`,'DELETE',undefined,member);
  const revoked=await fetch(new URL('/mcp',base),{method:'POST',headers:{Authorization:`Bearer ${agent}`,'Content-Type':'application/json'},body:'{}'});
  assert.equal(revoked.status,401);
  console.log('HTTP + MCP smoke passed: room creation, setup, all 6 tools, state provenance, origin checks, input limits, and revocation.');
}finally{await client.close();}
