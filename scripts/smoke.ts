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
const connection=await request('/api/agents','POST',{name:'Smoke agent',client:'codex'},member);
assert.equal(connection.status,201);
const agent=connection.body.token;
const peerConnection=await request('/api/agents','POST',{name:'Second agent',client:'claude'},member);
assert.equal(peerConnection.status,201);
const peer=new Client({name:'patchwork-peer-smoke',version:'1.0.0'});
assert.equal((await request('/api/board','GET',undefined,agent)).status,401,'Agent token must not grant browser administration');
assert.equal((await request('/api/instructions','PUT',{instructions:'Run tests before pushing.',version:0},member)).status,200);
const client=new Client({name:'patchwork-smoke',version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:`Bearer ${agent}`}}}));
try {
  await peer.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:`Bearer ${peerConnection.body.token}`}}}));
  const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['acknowledge_request','check_board','post_message','read_messages','resolve_request']);
  assert.ok(!('recipientId' in tools.tools.find(t=>t.name==='post_message')!.inputSchema.properties!));
  assert.ok(!('relevant_only' in tools.tools.find(t=>t.name==='read_messages')!.inputSchema.properties!));
  const call=async(name:string,args:Record<string,unknown>,who=client)=>{
    const result=await who.callTool({name,arguments:args});
    assert.ok(!result.isError,JSON.stringify(result));
    return JSON.parse((result.content as {type:string;text:string}[])[0].text);
  };
  const initial=await call('check_board',{session_id:'smoke-session',hook_event_name:'UserPromptSubmit'});
  assert.match(initial.hookSpecificOutput.additionalContext,/Run tests before pushing/);
  await call('check_board',{session_id:'smoke-session',hook_event_name:'UserPromptSubmit'},peer);
  const obsolete=await request('/api/messages','POST',{body:'Obsolete recipient',recipientId:connection.body.id},member);
  assert.equal(obsolete.status,400);
  const obsoleteTool=await client.callTool({name:'post_message',arguments:{body:'Obsolete recipient',recipientId:connection.body.id}});
  assert.ok(obsoleteTool.isError);
  const posted=(await request('/api/messages','POST',{body:'Second agent, could you add a test endpoint?',kind:'request'},member)).body;
  assert.equal((await request(`/api/requests/${posted.id}/claim`,'POST',{},member)).status,404);
  assert.equal((await request(`/api/agents/${connection.body.id}`,'PATCH',{scope:'obsolete'},member)).status,404);
  for(const who of [client,peer]) {
    const delivery=await call('check_board',{session_id:'smoke-session',hook_event_name:'UserPromptSubmit'},who);
    assert.match(delivery.hookSpecificOutput.additionalContext,/Second agent, could you add a test endpoint/);
    assert.ok(!delivery.hookSpecificOutput.additionalContext.includes('recipientId'));
    assert.deepEqual(await call('check_board',{session_id:'smoke-session',hook_event_name:'UserPromptSubmit'},who),{});
  }
  await call('post_message',{body:'The endpoint is available.',kind:'message',replyTo:posted.id});
  const stillOpen=await call('read_messages',{open_only:true});
  assert.equal(stillOpen.messages[0].status,'open','A reply must not resolve a request');
  assert.ok(stillOpen.messages[0].acknowledgments.every((a:any)=>a.response===null));
  const first=await call('acknowledge_request',{request_id:posted.id,response:'cannot_handle'});
  assert.equal(first.needsHumanIntervention,false,'An unanswered agent is not a decline');
  const flagged=await call('acknowledge_request',{request_id:posted.id,response:'cannot_handle'},peer);
  assert.equal(flagged.needsHumanIntervention,true);assert.equal(flagged.status,'open');
  const intervention=await request('/api/board?filter=intervention','GET',undefined,member);
  assert.equal(intervention.body.needsHumanIntervention,1);assert.equal(intervention.body.messages[0].id,posted.id);
  const spoofed=await client.callTool({name:'acknowledge_request',arguments:{request_id:posted.id,response:'can_handle',agent_id:peerConnection.body.id}});
  assert.ok(spoofed.isError);
  for(const who of [client,peer]) {
    const responses=await call('check_board',{session_id:'smoke-session',hook_event_name:'UserPromptSubmit'},who);
    assert.equal(responses.hookSpecificOutput.additionalContext.match(/Request response: Cannot handle/g)?.length,2);
    assert.deepEqual(await call('check_board',{session_id:'smoke-session',hook_event_name:'UserPromptSubmit'},who),{});
  }
  await call('acknowledge_request',{request_id:posted.id,response:'need_clarification'},peer);
  assert.equal((await request('/api/board?filter=intervention','GET',undefined,member)).body.needsHumanIntervention,0);
  const accepted=await call('acknowledge_request',{request_id:posted.id,response:'can_handle'},peer);
  assert.equal(accepted.status,'open');
  await call('resolve_request',{request_id:posted.id},peer);
  const feed=await call('read_messages',{after_id:0,limit:100});
  assert.ok(feed.messages.length>=3);assert.equal(feed.openRequests.length,0);
  await call('resolve_request',{request_id:posted.id,reopen:true});
  const open=await call('read_messages',{after_id:0,open_only:true});
  assert.deepEqual(open.messages.map((m:any)=>m.id),[posted.id]);
  assert.equal(open.messages[0].status,'open');
  assert.ok(!('claimed_by' in open.messages[0]));
  assert.ok(!('recipient_id' in open.messages[0]));
  await call('resolve_request',{request_id:posted.id});
  const board=await request('/api/board','GET',undefined,member);
  assert.equal(board.body.room.instructions,'Run tests before pushing.');
  assert.ok(!('integration' in board.body));
  assert.ok(!('scope' in board.body.agents[0]));
  assert.ok(board.body.agents.every((a:any)=>a.last_hook_at&&a.last_seen_at));
  assert.ok(board.body.messages.every((m:any)=>!('recipient_id' in m)));
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
  await request(`/api/agents/${peerConnection.body.id}`,'DELETE',undefined,member);
  console.log('HTTP + MCP smoke passed: all 5 board/hook tools, per-agent responses, intervention filter, shared delivery, explicit resolution, instructions, origin checks, input limits, and revocation.');
}finally{await Promise.all([client.close(),peer.close()]);}
