import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { authenticate, createAgent, createRoom, postMessage, readMessages, saveInstructions, requestAction } from '../src/domain';
import { checkBoard, CHECK_INTERVAL_MS, INSTRUCTION_INTERVAL_MS } from '../src/hooks';
import { hookConfiguration } from '../src/connections';

async function fixture() {
  const { db, sqlite } = database();
  const room = await createRoom(db,{name:'Hook room',memberName:'Owner'});
  const owner = await authenticate(db,`Bearer ${room.token}`,'member');
  const one = await createAgent(db,owner,{name:'Teammate A',client:'codex'});
  const two = await createAgent(db,owner,{name:'Teammate B',client:'claude'});
  const agent = await authenticate(db,`Bearer ${one.token}`,'agent');
  const peer = await authenticate(db,`Bearer ${two.token}`,'agent');
  return { db, sqlite, owner, agent, peer };
}
const event = (session='chat-1', kind='PostToolUse') => ({session_id:session,hook_event_name:kind});
const context = (result: Awaited<ReturnType<typeof checkBoard>>) => result.hookSpecificOutput?.additionalContext ?? '';
const start = 1_000_000;

test('startup hooks deliver the same board to every agent with identities and custom instructions',async()=>{
  const {db,sqlite,owner,agent,peer}=await fixture();
  sqlite.prepare('UPDATE agents SET scope = ?').run('Legacy authoritative scope');
  await saveInstructions(db,owner,{instructions:'Run tests before pushing.',version:0});
  const request=await postMessage(db,owner,{body:'Teammate A, can you help?',kind:'request'});
  sqlite.prepare('UPDATE messages SET recipient_id = ? WHERE id = ?').run(agent.id,request.id);
  await postMessage(db,owner,{body:'Teammate B, here is some context'});
  await postMessage(db,owner,{body:'Everyone: API shapes are ready'});
  for(const actor of [agent,peer]) {
    const result=await checkBoard(db,actor,event('chat-1','SessionStart'),start);
    assert.equal(result.hookSpecificOutput?.hookEventName,'SessionStart');
    const text=context(result);
    assert.match(text,/Teammate A|Teammate B/);assert.ok(text.includes(actor.id));
    assert.ok(!text.includes('Legacy authoritative scope'));assert.ok(!text.includes('recipientId'));assert.ok(!text.includes('claim'));
    assert.match(text,/Run tests before pushing/);assert.match(text,/Teammate A, can you help/);
    assert.match(text,/Teammate B, here is some context/);assert.match(text,/Everyone: API/);
    assert.ok(!('decision' in result));assert.ok(!('continue' in result));
  }
});

test('tool checkpoints throttle, cursors deduplicate, and separate chats get their own context',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await postMessage(db,owner,{body:'First announcement'});
  await checkBoard(db,agent,event(),start);
  await postMessage(db,owner,{body:'Next announcement'});
  assert.deepEqual(await checkBoard(db,agent,event(),start+1000),{});
  const next=await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS);
  assert.match(context(next),/Next announcement/);assert.ok(!context(next).includes('First announcement'));
  assert.deepEqual(await checkBoard(db,agent,event(),start+2*CHECK_INTERVAL_MS),{});
  assert.match(context(await checkBoard(db,agent,event('chat-2'),start+2000)),/First announcement/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM hook_sessions').get()!.n,2);
  assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM hook_sessions').all()).includes('chat-1'));
});

test('instructions repeat at the next eligible checkpoint and changes and clearing are delivered',async()=>{
  const {db,owner,agent}=await fixture();
  await saveInstructions(db,owner,{instructions:'Sync when safe.',version:0});
  await checkBoard(db,agent,event(),start);
  assert.deepEqual(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS),{});
  assert.match(context(await checkBoard(db,agent,event(),start+INSTRUCTION_INTERVAL_MS)),/Sync when safe/);
  await saveInstructions(db,owner,{instructions:'Run tests.',version:1});
  assert.match(context(await checkBoard(db,agent,event('chat-1','UserPromptSubmit'),start+INSTRUCTION_INTERVAL_MS+1000)),/Run tests/);
  await saveInstructions(db,owner,{instructions:'',version:2});
  assert.match(context(await checkBoard(db,agent,event('chat-1','UserPromptSubmit'),start+INSTRUCTION_INTERVAL_MS+2000)),/cleared the custom instructions/);
  assert.deepEqual(await checkBoard(db,agent,event(),start+2*INSTRUCTION_INTERVAL_MS+2000),{});
});

test('session resume and compaction refresh the roster without replaying old messages',async()=>{
  const {db,owner,agent}=await fixture();
  await postMessage(db,owner,{body:'Read once'});
  await checkBoard(db,agent,event(),start);
  const resumed=context(await checkBoard(db,agent,event('chat-1','SessionStart'),start+1000));
  assert.match(resumed,/Your agent id/);assert.ok(!resumed.includes('Read once'));
  await createAgent(db,owner,{name:'New teammate'});
  assert.match(context(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS+1000)),/New teammate/);
});

test('a simultaneous hook event gets one delivery and releases its lease',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await postMessage(db,owner,{body:'Once per checkpoint'});
  const results=await Promise.all([checkBoard(db,agent,event(),start),checkBoard(db,agent,event(),start)]);
  assert.equal(results.filter(r=>context(r).includes('Once per checkpoint')).length,1);
  assert.equal(sqlite.prepare('SELECT lease_until FROM hook_sessions').get()!.lease_until,0);
});

test('bounded previews do not skip a backlog, and failures preserve the cursor for retry',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await checkBoard(db,agent,event(),start-CHECK_INTERVAL_MS);
  const ids=[];
  for(let i=0;i<25;i++)ids.push((await postMessage(db,owner,{body:`Message ${i}: `+'x'.repeat(7000)})).id);
  let all='';
  for(let i=0;i<10;i++) {
    const text=context(await checkBoard(db,agent,event(),start+i*CHECK_INTERVAL_MS));
    assert.ok(text.length<=12000);all+=text;
  }
  for(const id of ids)assert.ok(all.includes(`"id":${id},`),`message ${id} delivered`);
  const before=sqlite.prepare('SELECT cursor FROM hook_sessions').get()!.cursor;
  const prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(sql.startsWith('SELECT m.*'))throw new Error('temporary database failure');return prepare(sql);}) as typeof db.prepare;
  await assert.rejects(checkBoard(db,agent,event(),start+20*CHECK_INTERVAL_MS),/temporary database failure/);
  db.prepare=prepare;
  assert.equal(sqlite.prepare('SELECT cursor FROM hook_sessions').get()!.cursor,before);
  assert.equal(sqlite.prepare('SELECT lease_until FROM hook_sessions').get()!.lease_until,0);
});

test('thread replies are delivered while hook history stays isolated by room',async()=>{
  const {db,owner,agent,peer}=await fixture();
  const request=await postMessage(db,agent,{body:'Need field',kind:'request'});
  await checkBoard(db,agent,event(),start);
  await postMessage(db,peer,{body:'Here is the field',replyTo:request.id});
  const second=await createRoom(db,{name:'Secret room',memberName:'Other'});
  const outsider=await authenticate(db,`Bearer ${second.token}`,'member');
  await postMessage(db,outsider,{body:'Room-private secret'});
  const text=context(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS));
  assert.match(text,/Here is the field/);assert.ok(!text.includes('Room-private secret'));
  await assert.rejects(checkBoard(db,owner,event(),start),/agent connection/);
});

test('generated hook configs pass only lifecycle metadata and exclude board tool recursion',()=>{
  const config=hookConfiguration();
  for(const [name,groups] of Object.entries(config.hooks)) {
    const handler=groups[0].hooks[0];
    assert.equal(handler.type,'mcp_tool');assert.equal(handler.tool,'check_board');
    assert.deepEqual(Object.keys(handler.input),['session_id','hook_event_name']);
    if(name==='PostToolUse') {
      const matcher=new RegExp(groups[0].matcher!);
      assert.ok(matcher.test('Bash'));assert.ok(!matcher.test('mcp__patchwork__post_message'));
    }
  }
});

test('large rosters never truncate owner instructions',async()=>{
  const {db,owner,agent}=await fixture();
  for(let i=0;i<12;i++)await createAgent(db,owner,{name:`Agent ${i} `+'n'.repeat(60),client:'other'});
  const instructions='i'.repeat(3900)+' END OF OWNER INSTRUCTIONS';
  await saveInstructions(db,owner,{instructions,version:0});
  const text=context(await checkBoard(db,agent,event(),start));
  assert.ok(text.includes(instructions));assert.ok(text.length<=12000);
});

test('first contact prioritizes old open requests and recent context, then skips historical backlog',async()=>{
  const {db,sqlite,owner,agent,peer}=await fixture();
  const open=await postMessage(db,owner,{body:'Old open request for you',kind:'request'});
  const resolved=await postMessage(db,owner,{body:'Old resolved request',kind:'request'});
  await requestAction(db,owner,resolved.id,'resolve');
  for(let i=0;i<60;i++)await postMessage(db,owner,{body:`Archived announcement ${i}`});
  await postMessage(db,owner,{body:'Teammate B, another request',kind:'request'});
  for(let i=0;i<3;i++)await postMessage(db,owner,{body:`Recent context ${i}`});
  const boundary=Number(sqlite.prepare('SELECT MAX(id) AS id FROM messages').get()!.id);
  const first=context(await checkBoard(db,agent,event(),start));
  assert.match(first,/Old open request for you/);assert.match(first,/Recent context 2/);
  assert.ok(!first.includes('Archived announcement'));assert.ok(!first.includes('Old resolved request'));assert.ok(first.includes('Teammate B, another request'));
  assert.equal(first.split(`"id":${open.id},`).length-1,1);
  assert.equal(sqlite.prepare('SELECT cursor FROM hook_sessions').get()!.cursor,boundary);
  assert.deepEqual(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS),{});
  await postMessage(db,owner,{body:'New after initialization'});
  const next=context(await checkBoard(db,agent,event(),start+2*CHECK_INTERVAL_MS));
  assert.match(next,/New after initialization/);assert.ok(!next.includes('Archived announcement'));
});

test('large initial request sets stay bounded and all remaining requests are readable with a cursor',async()=>{
  const {db,owner,agent}=await fixture();
  await saveInstructions(db,owner,{instructions:'i'.repeat(4000),version:0});
  for(let i=0;i<30;i++)await postMessage(db,owner,{body:`Request ${i}: `+'r'.repeat(7000),kind:'request'});
  const first=context(await checkBoard(db,agent,event(),start));
  assert.ok(first.length<=12000);assert.match(first,/More open requests/);
  assert.ok(first.includes('i'.repeat(4000)));
  const ids=new Set<number>();let cursor=0,more=true;
  while(more) {
    const page=await readMessages(db,agent,cursor,7,{openOnly:true});
    page.messages.forEach(m=>ids.add(m.id));cursor=page.nextCursor;more=page.hasMore;
  }
  assert.equal(ids.size,30);
  assert.deepEqual(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS),{});
});

test('every agent receives new messages, replies, and status changes once, including its own posts',async()=>{
  const {db,owner,agent,peer}=await fixture();
  const third=await createAgent(db,owner,{name:'Third teammate'});
  const observer=await authenticate(db,`Bearer ${third.token}`,'agent');
  const agents=[agent,peer,observer];
  for(const actor of agents) await checkBoard(db,actor,event('same-session'),start);
  const request=await postMessage(db,agent,{body:'Teammate B, can you add a field?',kind:'request'});
  await postMessage(db,peer,{body:'Here is the field',replyTo:request.id});
  await requestAction(db,observer,request.id,'resolve');
  for(const actor of agents) {
    const text=context(await checkBoard(db,actor,event('same-session'),start+CHECK_INTERVAL_MS));
    assert.match(text,/Teammate B, can you add a field/);assert.match(text,/Here is the field/);assert.match(text,/Marked this request resolved/);
    assert.equal(text.split(`"id":${request.id},`).length-1,1);
    assert.deepEqual(await checkBoard(db,actor,event('same-session'),start+2*CHECK_INTERVAL_MS),{});
  }
});

test('failed initialization and failed cursor commits retry; abandoned leases expire',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await postMessage(db,owner,{body:'Recover initial request',kind:'request'});
  const prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(sql.startsWith('SELECT m.*'))throw new Error('read interrupted');return prepare(sql);}) as typeof db.prepare;
  await assert.rejects(checkBoard(db,agent,event(),start),/read interrupted/);
  db.prepare=prepare;
  assert.equal(sqlite.prepare('SELECT context_hash FROM hook_sessions').get()!.context_hash,'');
  assert.match(context(await checkBoard(db,agent,event(),start+1000)),/Recover initial request/);
  const prior=sqlite.prepare('SELECT cursor FROM hook_sessions').get()!.cursor;
  await postMessage(db,owner,{body:'Retry after failed commit'});
  db.prepare=((sql:string)=>{if(sql.startsWith('UPDATE hook_sessions SET cursor'))throw new Error('commit interrupted');return prepare(sql);}) as typeof db.prepare;
  await assert.rejects(checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS+1000),/commit interrupted/);
  db.prepare=prepare;
  assert.equal(sqlite.prepare('SELECT cursor FROM hook_sessions').get()!.cursor,prior);
  sqlite.prepare('UPDATE hook_sessions SET lease_until = ?').run(start+2*CHECK_INTERVAL_MS);
  assert.deepEqual(await checkBoard(db,agent,event('chat-1','UserPromptSubmit'),start+CHECK_INTERVAL_MS+2000),{});
  assert.match(context(await checkBoard(db,agent,event(),start+2*CHECK_INTERVAL_MS)),/Retry after failed commit/);
});

test('messages arriving during initialization are delivered on the next check',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await postMessage(db,owner,{body:'Before the boundary'});
  const prepare=db.prepare.bind(db);let inserted=false;
  db.prepare=((sql:string)=>{
    if(sql.startsWith('SELECT m.*')&&!inserted) {
      inserted=true;
      sqlite.prepare("INSERT INTO messages (room_id,author_id,author_name,author_type,kind,body,created_at) VALUES (?,?,?,'member','message',?,?)").run(owner.room.id,owner.id,owner.name,'Arrived during check','2026-01-01');
    }
    return prepare(sql);
  }) as typeof db.prepare;
  const initial=context(await checkBoard(db,agent,event(),start));
  db.prepare=prepare;
  assert.ok(!initial.includes('Arrived during check'));
  assert.match(context(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS)),/Arrived during check/);
});

test('failure after the cursor update rolls back the entire check',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await checkBoard(db,agent,event(),start);
  await postMessage(db,owner,{body:'Recover after partial transaction'});
  const before=sqlite.prepare('SELECT cursor, last_checked FROM hook_sessions').get();
  sqlite.exec("CREATE TRIGGER fail_check BEFORE UPDATE OF last_hook_at ON agents BEGIN SELECT RAISE(ABORT, 'interrupted transaction'); END");
  await assert.rejects(checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS),/interrupted transaction/);
  assert.deepEqual(sqlite.prepare('SELECT cursor, last_checked FROM hook_sessions').get(),before);
  sqlite.exec('DROP TRIGGER fail_check');
  assert.match(context(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS)),/Recover after partial transaction/);
});

test('an expired check cannot deliver or advance a cursor after another check takes its lease',async()=>{
  const {db,sqlite,owner,agent}=await fixture();
  await postMessage(db,owner,{body:'Lease-protected message'});
  const prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{
    if(sql.startsWith('UPDATE hook_sessions SET cursor')) sqlite.prepare('UPDATE hook_sessions SET lease_id = ?, lease_until = ?').run('replacement',start+15_000);
    return prepare(sql);
  }) as typeof db.prepare;
  assert.deepEqual(await checkBoard(db,agent,event(),start),{});
  db.prepare=prepare;
  assert.equal(sqlite.prepare('SELECT cursor FROM hook_sessions').get()!.cursor,0);
  assert.equal(sqlite.prepare('SELECT last_hook_at FROM agents WHERE id = ?').get(agent.id)!.last_hook_at,null);
  assert.match(context(await checkBoard(db,agent,event(),start+15_000)),/Lease-protected message/);
});
