import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { acknowledgeRequest, authenticate, createAgent, createRoom, HttpError, postMessage, readMessages, requestAction, rotateAgent, snapshot } from '../src/domain';

async function fixture() {
  const {db,sqlite}=database();
  const credentials=await createRoom(db,{name:'Requests',memberName:'Owner'});
  const owner=await authenticate(db,`Bearer ${credentials.token}`,'member');
  const agents=[];
  for(const name of ['One','Two']) {
    const connection=await createAgent(db,owner,{name});
    agents.push(await authenticate(db,`Bearer ${connection.token}`,'agent'));
  }
  const request=await postMessage(db,owner,{body:'Who can help?',kind:'request'});
  return {db,sqlite,owner,agents,request};
}
const errorStatus=(status:number)=>(error:unknown)=>error instanceof HttpError && error.status===status;

test('responses distinguish silence, support changes, and neither assign nor complete work',async()=>{
  const {db,owner,agents,request}=await fixture();
  const read=async()=>(await readMessages(db,owner,0,100,{openOnly:true})).messages[0];
  assert.deepEqual((await read()).acknowledgments!.map(a=>a.response),[null,null]);
  await postMessage(db,agents[0],{body:'Can handle',replyTo:request.id});
  assert.equal((await read()).acknowledgments![0].response,null,'Plain replies do not silently become structured responses');
  for(const response of ['cannot_handle','need_clarification','can_handle'] as const) {
    const updated=await acknowledgeRequest(db,agents[0],{request_id:request.id,response});
    assert.equal(updated.status,'open');assert.equal(updated.needsHumanIntervention,false);
    assert.equal(updated.acknowledgments![0].response,response);
    assert.equal(updated.acknowledgments![1].response,null);
    assert.ok(!('claimed_by' in updated));
  }
  const before=(await readMessages(db,owner)).messages.length;
  await Promise.all([1,2].map(()=>acknowledgeRequest(db,agents[0],{request_id:request.id,response:'can_handle'})));
  assert.equal((await readMessages(db,owner)).messages.length,before,'Unchanged retries do not append duplicate replies');
  const replies=(await readMessages(db,owner,request.id)).messages;
  assert.deepEqual(replies.slice(1).map(m=>m.body),['Request response: Cannot handle.','Request response: Need clarification.','Request response: Can handle.']);
  assert.ok(replies.every(m=>m.reply_to===request.id));
});

test('escalation requires every non-revoked agent to explicitly decline and follows roster changes',async()=>{
  const {db,owner,agents,request}=await fixture();
  const board=()=>snapshot(db,owner,0,'intervention');
  await acknowledgeRequest(db,agents[0],{request_id:request.id,response:'cannot_handle'});
  assert.equal((await board()).needsHumanIntervention,0,'Never-connected agents still count as unanswered');
  assert.equal((await board()).messages.length,0);
  await acknowledgeRequest(db,agents[1],{request_id:request.id,response:'need_clarification'});
  assert.equal((await board()).needsHumanIntervention,0);
  await acknowledgeRequest(db,agents[1],{request_id:request.id,response:'cannot_handle'});
  assert.equal((await board()).needsHumanIntervention,1);
  assert.equal((await board()).messages[0].needsHumanIntervention,true);
  assert.equal((await board()).messages[0].status,'open');
  const newcomer=await createAgent(db,owner,{name:'Newcomer'});
  assert.equal((await board()).needsHumanIntervention,0);
  await rotateAgent(db,owner,newcomer.id,true);
  assert.equal((await board()).needsHumanIntervention,1);
  await acknowledgeRequest(db,agents[1],{request_id:request.id,response:'can_handle'});
  assert.equal((await board()).needsHumanIntervention,0);
  await rotateAgent(db,owner,agents[1].id,true);
  assert.equal((await board()).needsHumanIntervention,1,'Revoked responses no longer affect escalation');
  const historical=(await board()).messages[0].acknowledgments!.find(a=>a.agent_id===agents[1].id)!;
  assert.equal(historical.active,false);assert.equal(historical.response,'can_handle');
  await rotateAgent(db,owner,agents[0].id,true);
  assert.equal((await board()).needsHumanIntervention,0,'Zero active agents is not unanimous decline');
  await rotateAgent(db,owner,agents[0].id);
  assert.equal((await board()).needsHumanIntervention,1,'Rotation preserves this identity’s latest response');
});

test('resolved requests leave intervention views; explicit reopening retains responses',async()=>{
  const {db,owner,agents,request}=await fixture();
  for(const agent of agents) await acknowledgeRequest(db,agent,{request_id:request.id,response:'cannot_handle'});
  await requestAction(db,owner,request.id,'resolve');
  assert.equal((await snapshot(db,owner)).needsHumanIntervention,0);
  const resolved=(await readMessages(db,owner)).messages[0];
  assert.equal(resolved.needsHumanIntervention,false);assert.equal(resolved.acknowledgments!.length,2);
  await assert.rejects(acknowledgeRequest(db,agents[0],{request_id:request.id,response:'can_handle'}),errorStatus(409));
  await requestAction(db,agents[0],request.id,'reopen');
  assert.equal((await snapshot(db,owner)).needsHumanIntervention,1);
  await acknowledgeRequest(db,agents[0],{request_id:request.id,response:'can_handle'});
  assert.equal((await snapshot(db,owner)).needsHumanIntervention,0);
});

test('agents can only acknowledge root requests in their own room with their own identity',async()=>{
  const {db,owner,agents,request}=await fixture();
  const credentials=await createRoom(db,{name:'Other room',memberName:'Other owner'});
  const outsider=await authenticate(db,`Bearer ${credentials.token}`,'member');
  const foreign=await createAgent(db,outsider,{name:'Foreign agent'});
  const foreignAgent=await authenticate(db,`Bearer ${foreign.token}`,'agent');
  const response={request_id:request.id,response:'cannot_handle'};
  await assert.rejects(acknowledgeRequest(db,owner,response),errorStatus(403));
  await assert.rejects(acknowledgeRequest(db,foreignAgent,response),errorStatus(404));
  await assert.rejects(acknowledgeRequest(db,agents[0],{...response,agent_id:agents[1].id}),errorStatus(400));
  await assert.rejects(acknowledgeRequest(db,agents[0],{...response,response:'assigned'}),errorStatus(400));
  const message=await postMessage(db,owner,{body:'Not a request'});
  const reply=await postMessage(db,owner,{body:'A reply',replyTo:request.id});
  for(const id of [message.id,reply.id,9999]) await assert.rejects(acknowledgeRequest(db,agents[0],{...response,request_id:id}),errorStatus(404));
  assert.deepEqual((await readMessages(db,foreignAgent)).messages,[]);
  await rotateAgent(db,owner,agents[0].id,true);
  await assert.rejects(acknowledgeRequest(db,agents[0],response),errorStatus(409));
  assert.ok((await readMessages(db,owner)).messages[0].acknowledgments!.every(a=>a.response===null));
});

test('failed broadcast rolls back the response; concurrent identical evaluations produce one reply',async()=>{
  const {db,sqlite,owner,agents,request}=await fixture();
  const response={request_id:request.id,response:'cannot_handle'};
  sqlite.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'reply failed'); END");
  await assert.rejects(acknowledgeRequest(db,agents[0],response),/reply failed/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM request_acknowledgments').get()!.n,0);
  sqlite.exec('DROP TRIGGER fail_reply');
  await Promise.all([1,2].map(()=>acknowledgeRequest(db,agents[0],response)));
  assert.equal((await readMessages(db,owner,request.id)).messages.length,1);
});

test('intervention filter finds old requests without losing threads or pagination',async()=>{
  const {db,owner,agents,request}=await fixture();
  for(const agent of agents) await acknowledgeRequest(db,agent,{request_id:request.id,response:'cannot_handle'});
  for(let i=0;i<35;i++) await postMessage(db,owner,{body:`Newer message ${i}`});
  assert.ok(!(await snapshot(db,owner)).messages.some(m=>m.id===request.id));
  const filtered=await snapshot(db,owner,0,'intervention');
  assert.equal(filtered.needsHumanIntervention,1);
  assert.equal(filtered.messages[0].id,request.id);
  assert.equal(filtered.messages.filter(m=>m.reply_to===request.id).length,2);
  assert.equal(filtered.nextBefore,null);
});
