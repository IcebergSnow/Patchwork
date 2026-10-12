import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import {
  authenticate, createAgent, createRoom, joinRoom, postMessage, readMessages, requestAction,
  rotateAgent, rotateInvite, snapshot, saveInstructions, updateAgent, HttpError,
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
  const created=await createAgent(db,owner,{name:'Alice / Codex',client:'codex',scope:'frontend/'});
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
  const agent=await createAgent(db,owner,{name:'Agent',client:'codex',scope:'ui/'});
  assert.deepEqual((await readMessages(db,outsider)).messages,[]);
  await assert.rejects(postMessage(db,outsider,{body:'Cross-room reply',replyTo:privateMessage.id}),errorStatus(404));
  await assert.rejects(requestAction(db,outsider,privateMessage.id,'claim'),errorStatus(404));
  await assert.rejects(rotateAgent(db,outsider,agent.id),errorStatus(404));
  await assert.rejects(authenticate(db,`Bearer ${agent.token}`,'member'),errorStatus(401));
  await assert.rejects(authenticate(db,`Bearer ${second.token}`,'agent'),errorStatus(401));
});

test('only one concurrent claimant wins, and claim changes appear after the cursor',async()=>{
  const {db,owner,credentials}=await fixture();
  const joined=await joinRoom(db,{name:'Bob',invite:credentials.invite});
  const bob=await authenticate(db,`Bearer ${joined.token}`,'member');
  const request=await postMessage(db,owner,{kind:'request',body:'Need ownerName.'});
  const attempts=await Promise.allSettled([requestAction(db,owner,request.id,'claim'),requestAction(db,bob,request.id,'claim')]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  const failed=attempts.find(a=>a.status==='rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.status,409);
  const updates=await readMessages(db,bob,request.id);
  assert.equal(updates.messages.length,1);
  assert.equal(updates.messages[0].reply_to,request.id);
  assert.match(updates.messages[0].body,/Claimed/);
});

test('request lifecycle respects requester, claimant, and owner permissions',async()=>{
  const {db,owner,credentials}=await fixture();
  const bobCredentials=await joinRoom(db,{name:'Bob',invite:credentials.invite});
  const eveCredentials=await joinRoom(db,{name:'Eve',invite:credentials.invite});
  const bob=await authenticate(db,`Bearer ${bobCredentials.token}`,'member');
  const eve=await authenticate(db,`Bearer ${eveCredentials.token}`,'member');
  const request=await postMessage(db,bob,{kind:'request',body:'Backend request'});
  await assert.rejects(requestAction(db,eve,request.id,'resolve'),errorStatus(403));
  await requestAction(db,owner,request.id,'claim');
  assert.equal((await requestAction(db,bob,request.id,'resolve')).status,'resolved');
  const reopened=await requestAction(db,bob,request.id,'reopen');
  assert.equal(reopened.status,'open');assert.equal(reopened.claimed_by,null);
  assert.equal((await requestAction(db,eve,request.id,'claim')).claimed_by,eve.id);
});

test('revocation and rotation invalidate old credentials without removing history',async()=>{
  const {db,owner,credentials}=await fixture();
  const agent=await createAgent(db,owner,{name:'Code',client:'claude',scope:'api/'});
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
  const one=await createAgent(db,owner,{name:'Frontend',client:'codex',scope:'ui/'});
  const two=await createAgent(db,owner,{name:'Backend',client:'claude',scope:'api/'});
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

test('participants can edit their own scopes and the room owner can manage scopes',async()=>{
  const {db,owner,credentials}=await fixture();
  const joined=await joinRoom(db,{name:'Bob',invite:credentials.invite});
  const bob=await authenticate(db,`Bearer ${joined.token}`,'member');
  const one=await createAgent(db,owner,{name:'Agent',client:'codex',scope:'ui/'});
  await assert.rejects(updateAgent(db,bob,one.id,{scope:'backend/'}),errorStatus(403));
  await updateAgent(db,owner,one.id,{scope:'frontend/'});
  assert.equal((await snapshot(db,owner)).agents[0].scope,'frontend/');
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
