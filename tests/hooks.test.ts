import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { authenticate, createAgent, createRoom, postMessage, saveInstructions, updateAgent } from '../src/domain';
import { checkBoard, CHECK_INTERVAL_MS, INSTRUCTION_INTERVAL_MS } from '../src/hooks';
import { hookConfiguration } from '../src/connections';

async function fixture() {
  const { db, sqlite } = database();
  const room = await createRoom(db,{name:'Hook room',memberName:'Owner'});
  const owner = await authenticate(db,`Bearer ${room.token}`,'member');
  const one = await createAgent(db,owner,{name:'Frontend',client:'codex',scope:'frontend/'});
  const two = await createAgent(db,owner,{name:'Backend',client:'claude',scope:'backend/'});
  const agent = await authenticate(db,`Bearer ${one.token}`,'agent');
  const backend = await authenticate(db,`Bearer ${two.token}`,'agent');
  return { db, sqlite, owner, agent, backend };
}
const event = (session='chat-1', kind='PostToolUse') => ({session_id:session,hook_event_name:kind});
const context = (result: Awaited<ReturnType<typeof checkBoard>>) => result.hookSpecificOutput?.additionalContext ?? '';
const start = 1_000_000;

test('native hook contract delivers scope, relevant messages, and custom instructions',async()=>{
  const {db,owner,agent,backend}=await fixture();
  await saveInstructions(db,owner,{instructions:'Run tests before pushing.',version:0});
  await postMessage(db,owner,{body:'For frontend',recipientId:agent.id,kind:'request'});
  await postMessage(db,owner,{body:'Backend only reminder',recipientId:backend.id});
  await postMessage(db,owner,{body:'Everyone: API shapes are ready'});
  const result=await checkBoard(db,agent,event('chat-1','UserPromptSubmit'),start);
  assert.equal(result.hookSpecificOutput?.hookEventName,'UserPromptSubmit');
  assert.match(context(result),/frontend\//);assert.match(context(result),/Run tests before pushing/);
  assert.match(context(result),/For frontend/);assert.match(context(result),/Everyone: API/);
  assert.ok(!context(result).includes('Backend only reminder'));
  assert.ok(!('decision' in result));assert.ok(!('continue' in result));
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

test('session resume and compaction reintroduce context, and scope updates reach an existing chat',async()=>{
  const {db,owner,agent}=await fixture();
  await checkBoard(db,agent,event(),start);
  assert.match(context(await checkBoard(db,agent,event('chat-1','SessionStart'),start+1000)),/Your assigned scope/);
  await updateAgent(db,owner,agent.id,{scope:'design-system/'});
  assert.match(context(await checkBoard(db,agent,event(),start+CHECK_INTERVAL_MS+1000)),/design-system/);
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

test('directed-thread replies reach the requesting agent and room isolation applies to hooks',async()=>{
  const {db,owner,agent,backend}=await fixture();
  const request=await postMessage(db,agent,{body:'Need field',kind:'request',recipientId:backend.id});
  await checkBoard(db,agent,event(),start);
  await postMessage(db,backend,{body:'Here is the field',replyTo:request.id});
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

test('long team scopes never truncate owner instructions',async()=>{
  const {db,owner,agent}=await fixture();
  await updateAgent(db,owner,agent.id,{scope:'Frontend '.repeat(200)});
  for(let i=0;i<12;i++)await createAgent(db,owner,{name:`Agent ${i} `+'n'.repeat(60),client:'other',scope:'Scope '.repeat(300)});
  const instructions='i'.repeat(3900)+' END OF OWNER INSTRUCTIONS';
  await saveInstructions(db,owner,{instructions,version:0});
  const text=context(await checkBoard(db,agent,event(),start));
  assert.ok(text.includes(instructions));assert.ok(text.length<=12000);
});
