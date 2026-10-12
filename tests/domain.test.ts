import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import {
  authenticate, createAgent, createRoom, joinRoom, postMessage, readMessages, requestAction,
  rotateAgent, rotateInvite, snapshot, saveInstructions, HttpError,
} from '../src/domain';

async function fixture() {
  const {db,sqlite}=database();
  const credentials=await createRoom(db,{name:'Test room',memberName:'Alice'});
  const owner=await authenticate(db,`Bearer ${credentials.token}`,'member');
  return {db,sqlite,credentials,owner};
}
const errorStatus = (status:number) => (error:unknown) => error instanceof HttpError && error.status===status;

test('rooms store credential hashes and never expose them through snapshots',async()=>{
  const {db,sqlite,credentials,owner}=await fixture();
  const created=await createAgent(db,owner,{name:'Alice / Codex',client:'codex'});
  const state=await snapshot(db,owner);
  assert.equal(state.agents[0].last_seen_at,null);
  assert.equal(state.room.name,'Test room');
  const payload=JSON.stringify(state);
  for(const forbidden of [credentials.token,credentials.invite,created.token,'token_hash','invite_hash'])assert.ok(!payload.includes(forbidden));
  assert.notEqual(sqlite.prepare('SELECT token_hash FROM members').get()!.token_hash,credentials.token);
});

test('room isolation covers messages, replies, agent management, and token types',async()=>{
  const {db,owner}=await fixture();
  const second=await createRoom(db,{name:'Other room',memberName:'Other'});
  const outsider=await authenticate(db,`Bearer ${second.token}`,'member');
  const privateMessage=await postMessage(db,owner,{body:'Private',kind:'request'});
  const agent=await createAgent(db,owner,{name:'Agent',client:'codex'});
  assert.deepEqual((await readMessages(db,outsider)).messages,[]);
  await assert.rejects(postMessage(db,outsider,{body:'Cross-room reply',replyTo:privateMessage.id}),errorStatus(404));
  await assert.rejects(requestAction(db,outsider,privateMessage.id,'resolve'),errorStatus(404));
  await assert.rejects(rotateAgent(db,outsider,agent.id),errorStatus(404));
  await assert.rejects(authenticate(db,`Bearer ${agent.token}`,'member'),errorStatus(401));
  await assert.rejects(authenticate(db,`Bearer ${second.token}`,'agent'),errorStatus(401));
});

test('request changes are atomic, idempotent, and visible after a message cursor',async()=>{
  const {db,owner}=await fixture();
  const request=await postMessage(db,owner,{kind:'request',body:'Need ownerName.'});
  await Promise.all([requestAction(db,owner,request.id,'resolve'),requestAction(db,owner,request.id,'resolve')]);
  const updates=await readMessages(db,owner,request.id);
  assert.equal(updates.messages.length,1);
  assert.equal(updates.messages[0].reply_to,request.id);
  assert.match(updates.messages[0].body,/resolved/);
  await requestAction(db,owner,request.id,'reopen');
  assert.equal((await snapshot(db,owner,0,true)).openRequests,1);
});

test('only the requester, intended recipient, or room owner can resolve and reopen',async()=>{
  const {db,owner,credentials}=await fixture();
  const joined=await joinRoom(db,{name:'Bob',invite:credentials.invite});
  const bob=await authenticate(db,`Bearer ${joined.token}`,'member');
  const target=await createAgent(db,bob,{name:'Target'});
  const recipient=await authenticate(db,`Bearer ${target.token}`,'agent');
  const other=await createAgent(db,owner,{name:'Other'});
  const unrelated=await authenticate(db,`Bearer ${other.token}`,'agent');
  const request=await postMessage(db,bob,{kind:'request',body:'Need help',recipientId:target.id});
  await postMessage(db,unrelated,{body:'I can help too',replyTo:request.id});
  for(const action of ['resolve','reopen'] as const) await assert.rejects(requestAction(db,unrelated,request.id,action),errorStatus(403));
  for(const actor of [recipient,bob,owner]) {
    assert.equal((await requestAction(db,actor,request.id,'resolve')).status,'resolved');
    assert.equal((await requestAction(db,actor,request.id,'reopen')).status,'open');
  }
  const broadcast=await postMessage(db,bob,{kind:'request',body:'Everyone: help'});
  await assert.rejects(requestAction(db,recipient,broadcast.id,'resolve'),errorStatus(403));
  assert.equal((await requestAction(db,bob,broadcast.id,'resolve')).status,'resolved');
});

test('revocation and rotation invalidate old credentials without removing history',async()=>{
  const {db,owner,credentials}=await fixture();
  const agent=await createAgent(db,owner,{name:'Code',client:'claude'});
  const actor=await authenticate(db,`Bearer ${agent.token}`,'agent');
  await postMessage(db,actor,{body:'Keep this history.'});
  const replaced=await rotateAgent(db,owner,agent.id);
  await assert.rejects(authenticate(db,`Bearer ${agent.token}`,'agent'),errorStatus(401));
  assert.equal((await authenticate(db,`Bearer ${replaced.token}`,'agent')).id,agent.id);
  await rotateAgent(db,owner,agent.id,true);
  await assert.rejects(authenticate(db,`Bearer ${replaced.token}`,'agent'),errorStatus(401));
  assert.equal((await readMessages(db,owner)).messages[0].body,'Keep this history.');
  const invite=await rotateInvite(db,owner);
  await assert.rejects(joinRoom(db,{name:'New',invite:credentials.invite}),errorStatus(404));
  await joinRoom(db,{name:'New',invite:invite.invite});
  assert.equal((await authenticate(db,`Bearer ${credentials.token}`,'member')).id,owner.id);
});

test('only the owner edits instructions and stale edits cannot overwrite newer text',async()=>{
  const {db,owner,credentials}=await fixture();
  const joined=await joinRoom(db,{name:'Bob',invite:credentials.invite});
  const bob=await authenticate(db,`Bearer ${joined.token}`,'member');
  await assert.rejects(saveInstructions(db,bob,{instructions:'Take over',version:0}),errorStatus(403));
  const updated=await saveInstructions(db,owner,{instructions:'Run tests before pushing.',version:0});
  assert.equal(updated.instructions_version,1);
  await assert.rejects(saveInstructions(db,owner,{instructions:'Stale',version:0}),errorStatus(409));
  const fresh=await authenticate(db,`Bearer ${credentials.token}`,'member');
  const state=await snapshot(db,fresh);
  assert.equal(state.room.instructions,'Run tests before pushing.');
  assert.ok(!('integration' in state));assert.ok(!('merger_id' in state.room));
  await saveInstructions(db,owner,{instructions:'',version:1});
});

test('directed messages stay room-visible and replies retain their recipient',async()=>{
  const {db,owner}=await fixture();
  const one=await createAgent(db,owner,{name:'Frontend',client:'codex'});
  const two=await createAgent(db,owner,{name:'Backend',client:'claude'});
  const frontend=await authenticate(db,`Bearer ${one.token}`,'agent');
  const backend=await authenticate(db,`Bearer ${two.token}`,'agent');
  const root=await postMessage(db,frontend,{body:'Need ownerName',kind:'request',recipientId:two.id});
  const reply=await postMessage(db,backend,{body:'On it',replyTo:root.id});
  assert.equal(reply.recipient_id,two.id);
  assert.equal((await readMessages(db,owner)).messages[0].recipient_id,two.id);
  await assert.rejects(postMessage(db,frontend,{body:'Redirect',replyTo:root.id,recipientId:one.id}),errorStatus(400));
  const other=await createRoom(db,{name:'Other',memberName:'Other'});
  const otherOwner=await authenticate(db,`Bearer ${other.token}`,'member');
  await assert.rejects(postMessage(db,otherOwner,{body:'Cross room',recipientId:two.id}),errorStatus(400));
  await rotateAgent(db,owner,two.id,true);
  await assert.rejects(postMessage(db,owner,{body:'Revoked target',recipientId:two.id}),errorStatus(400));
});

test('an identity alone creates a connection; old scope data is not exposed or changed',async()=>{
  const {db,sqlite,owner}=await fixture();
  const created=await createAgent(db,owner,{name:'Agent'});
  assert.equal((await authenticate(db,`Bearer ${created.token}`,'agent')).id,created.id);
  sqlite.prepare('UPDATE agents SET scope = ? WHERE id = ?').run('Historical responsibility',created.id);
  const state=await snapshot(db,owner);
  assert.equal(state.agents[0].client,'other');
  assert.ok(!('scope' in state.agents[0]));
  assert.equal(sqlite.prepare('SELECT scope FROM agents WHERE id = ?').get(created.id)!.scope,'Historical responsibility');
});

test('board operations preserve event history without writing unused activity records',async()=>{
  const {db,sqlite,owner,credentials}=await fixture();
  sqlite.prepare('INSERT INTO events (room_id,actor_name,kind,summary,created_at) VALUES (?,?,?,?,?)').run(owner.room.id,'Alice','legacy','Historical event','2025-01-01');
  await joinRoom(db,{name:'Bob',invite:credentials.invite});
  await rotateInvite(db,owner);
  const agent=await createAgent(db,owner,{name:'Agent'});
  await saveInstructions(db,owner,{instructions:'Run tests.',version:0});
  const request=await postMessage(db,owner,{kind:'request',body:'Help'});
  await requestAction(db,owner,request.id,'resolve');
  await rotateAgent(db,owner,agent.id);
  await rotateAgent(db,owner,agent.id,true);
  assert.deepEqual(sqlite.prepare('SELECT summary FROM events').all().map(row=>row.summary),['Historical event']);
});

test('message cursors and older threads retain replies and pending requests',async()=>{
  const {db,owner}=await fixture();
  const first=await postMessage(db,owner,{body:'Old unresolved request',kind:'request'});
  for(let i=0;i<35;i++)await postMessage(db,owner,{body:`Note ${i}`});
  await postMessage(db,owner,{body:'Late reply to the oldest thread',replyTo:first.id});
  const recent=await snapshot(db,owner);
  assert.ok(recent.nextBefore);
  assert.equal(recent.messages.filter(m=>m.reply_to===null).length,30);
  const older=await snapshot(db,owner,recent.nextBefore!);
  assert.ok(older.messages.some(m=>m.reply_to===first.id));
  const open=await snapshot(db,owner,0,true);
  assert.equal(open.openRequests,1);
  assert.equal(open.messages.find(m=>m.id===first.id)!.body,'Old unresolved request');
  const firstPage=await readMessages(db,owner,0,10),secondPage=await readMessages(db,owner,firstPage.nextCursor,10);
  assert.equal(firstPage.hasMore,true);
  assert.ok(secondPage.messages.every(m=>m.id>firstPage.nextCursor));
});

test('input validation prevents empty posts and unsafe repository links',async()=>{
  const {db,owner}=await fixture();
  await assert.rejects(postMessage(db,owner,{body:'  '}),errorStatus(400));
  await assert.rejects(createRoom(db,{name:'Unsafe',memberName:'Alice',repository:'javascript:alert(1)'}),errorStatus(400));
  await assert.rejects(createRoom(db,{name:'Unsafe',memberName:'Alice',repository:'https://user:password@example.com/repo'}),errorStatus(400));
  const root=await postMessage(db,owner,{body:'A thread'});
  await assert.rejects(postMessage(db,owner,{body:'Nested request',kind:'request',replyTo:root.id}),errorStatus(400));
});
