import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database } from './database';
import { authenticate, createAgent, createRoom, postMessage, readMessages, snapshot, acknowledgeRequest } from '../src/domain';

test('upgrade preserves rooms, credentials, threads, categories, scopes, and history',async()=>{
  const {db,sqlite}=database(2);
  const credentials=await createRoom(db,{name:'Existing room',memberName:'Alice'});
  const owner=await authenticate(db,`Bearer ${credentials.token}`,'member');
  const connection=await createAgent(db,owner,{name:'Existing agent'});
  sqlite.prepare('UPDATE agents SET scope = ? WHERE id = ?').run('Historical scope',connection.id);
  const insert=sqlite.prepare('INSERT INTO messages (id,room_id,author_id,author_name,author_type,kind,body,reply_to,status,claimed_by,claimed_name,created_at,recipient_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(10,owner.room.id,owner.id,owner.name,'member','request','Original request',null,'claimed',connection.id,'Existing agent','2025-01-01',connection.id);
  for(const [index,kind] of ['note','update','ready','integration'].entries()) insert.run(11+index,owner.room.id,owner.id,owner.name,'member',kind,`Original ${kind}`,10,null,null,null,'2025-01-02',connection.id);
  sqlite.prepare('INSERT INTO events (room_id,actor_name,kind,summary,created_at) VALUES (?,?,?,?,?)').run(owner.room.id,'Alice','legacy','Old event','2025-01-01');
  sqlite.prepare('INSERT INTO integrations (room_id,commit_sha,status,summary,reported_by,reported_at,source) VALUES (?,?,?,?,?,?,?)').run(owner.room.id,'abc123','passed','Old report','Alice','2025-01-01','member');
  sqlite.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'messages'").run();
  const preserved=['rooms','members','agents','events','integrations'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all()] as const);
  sqlite.exec('BEGIN');
  sqlite.exec(readFileSync(new URL('../migrations/0003_simple_board.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_request_acknowledgments.sql',import.meta.url),'utf8'));
  sqlite.exec('COMMIT');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const [table,rows] of preserved) assert.deepEqual(sqlite.prepare(`SELECT * FROM ${table}`).all(),rows);
  assert.equal((await authenticate(db,`Bearer ${credentials.token}`,'member')).id,owner.id);
  assert.equal((await authenticate(db,`Bearer ${connection.token}`,'agent')).id,connection.id);
  const request=sqlite.prepare('SELECT * FROM messages WHERE id = 10').get()!;
  assert.equal(request.status,'open');assert.equal(request.claimed_by,connection.id);
  assert.equal(request.recipient_id,connection.id);assert.equal(request.body,'Original request');
  assert.deepEqual(sqlite.prepare('SELECT kind FROM messages WHERE id > 10').all().map(row=>row.kind),['note','update','ready','integration']);
  const feed=await readMessages(db,owner);
  assert.deepEqual(feed.messages.map(row=>row.kind),['request','message','message','message','message']);
  assert.ok(feed.messages.slice(1).every(row=>row.reply_to===10));
  assert.ok(!('claimed_by' in feed.messages[0]));
  assert.ok(feed.messages.every(message=>!('recipient_id' in message)));
  assert.equal((await snapshot(db,owner,0,'open')).openRequests,1);
  assert.equal((await postMessage(db,owner,{body:'New message'})).id,100);
  assert.throws(()=>sqlite.prepare("UPDATE messages SET status = 'claimed' WHERE id = 10").run(),/CHECK constraint/);
});

test('acknowledgment migration leaves messages, instructions, and hook cursors intact',async()=>{
  const {db,sqlite}=database(3);
  const credentials=await createRoom(db,{name:'Existing board',memberName:'Owner'});
  const owner=await authenticate(db,`Bearer ${credentials.token}`,'member');
  const connection=await createAgent(db,owner,{name:'Existing agent'});
  const request=await postMessage(db,owner,{body:'Keep this open',kind:'request'});
  sqlite.prepare('UPDATE rooms SET instructions = ?, instructions_version = 3').run('Keep testing.');
  sqlite.prepare('INSERT INTO hook_sessions (agent_id,session_hash,cursor,last_checked,last_instructions,instructions_version,context_hash,lease_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(connection.id,'existing-session',request.id,1000,900,3,'old-context','old-lease');
  const tables=['rooms','members','agents','messages','hook_sessions'];
  const before=tables.map(table=>sqlite.prepare(`SELECT * FROM ${table}`).all());
  sqlite.exec(readFileSync(new URL('../migrations/0004_request_acknowledgments.sql',import.meta.url),'utf8'));
  tables.forEach((table,i)=>assert.deepEqual(sqlite.prepare(`SELECT * FROM ${table}`).all(),before[i]));
  const old=(await readMessages(db,owner)).messages[0];
  assert.equal(old.acknowledgments![0].response,null);assert.equal(old.needsHumanIntervention,false);
  const actor=await authenticate(db,`Bearer ${connection.token}`,'agent');
  await acknowledgeRequest(db,actor,{request_id:request.id,response:'cannot_handle'});
  assert.equal((await snapshot(db,owner)).needsHumanIntervention,1);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('pairing migration preserves every existing table and its rows', async () => {
  const {db,sqlite} = database(4);
  const credentials = await createRoom(db,{name:'Existing board',memberName:'Owner'});
  const owner = await authenticate(db,`Bearer ${credentials.token}`,'member');
  const connection = await createAgent(db,owner,{name:'Existing agent'});
  const request = await postMessage(db,owner,{body:'Keep this request',kind:'request'});
  const actor = await authenticate(db,`Bearer ${connection.token}`,'agent');
  await acknowledgeRequest(db,actor,{request_id:request.id,response:'need_clarification'});
  sqlite.prepare('INSERT INTO hook_sessions (agent_id,session_hash,cursor,lease_id) VALUES (?,?,?,?)').run(connection.id,'existing',request.id,'existing-lease');
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name));
  const before = tables.map(table=>sqlite.prepare(`SELECT * FROM ${table}`).all());
  sqlite.exec(readFileSync(new URL('../migrations/0005_pairing.sql',import.meta.url),'utf8'));
  tables.forEach((table,i)=>assert.deepEqual(sqlite.prepare(`SELECT * FROM ${table}`).all(),before[i]));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});
