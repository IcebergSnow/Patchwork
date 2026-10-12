import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { authenticate, createAgent, createRoom, hash, HttpError, joinRoom, snapshot } from '../src/domain';
import { createPairing, redeemPairing } from '../src/pairing';
import worker, { type Env } from '../src/worker';

async function fixture() {
  const { db, sqlite } = database();
  const room = await createRoom(db, { name: 'Pairing room', memberName: 'Alice' });
  const owner = await authenticate(db, `Bearer ${room.token}`, 'member');
  return { db, sqlite, room, owner };
}
const invalid = (error: unknown) => error instanceof HttpError && error.status === 400;

test('any authenticated member can authorize pairing, bound to that member and room', async () => {
  const {db,sqlite,room,owner} = await fixture();
  const membership = await joinRoom(db, { invite: room.invite, name: 'Bob' });
  const member = await authenticate(db, `Bearer ${membership.token}`, 'member');
  const pairing = await createPairing(db, member);
  assert.match(pairing.code, /^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}$/);
  assert.ok(Date.parse(pairing.expiresAt) > Date.now() + 590_000);
  assert.ok(Date.parse(pairing.expiresAt) <= Date.now() + 600_000);
  const stored = sqlite.prepare('SELECT * FROM pairing_codes').get()!;
  assert.equal(stored.code_hash, await hash(pairing.code.replaceAll('-', '')));
  assert.ok(!JSON.stringify(stored).includes(pairing.code));
  assert.equal((await snapshot(db, owner)).agents.length, 0);
  const paired = await redeemPairing(db, {code: pairing.code.toLowerCase()});
  const actor = await authenticate(db, `Bearer ${paired.token}`, 'agent');
  assert.equal(actor.memberId, member.id);
  assert.equal(actor.room.id, room.roomId);
  assert.equal(actor.name, 'Bob / Codex');
  assert.equal(paired.roomId, room.roomId);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM pairing_codes').get()!.n, 0);
  assert.notEqual(sqlite.prepare('SELECT token_hash FROM agents').get()!.token_hash, paired.token);
  await assert.rejects(authenticate(db, `Bearer ${paired.token}`, 'member'));
  assert.ok(!JSON.stringify(await snapshot(db, owner)).includes(paired.token));
});

test('codes expire, cannot be guessed or replayed, and a replacement invalidates the previous code', async () => {
  const {db,sqlite,owner} = await fixture();
  const old = await createPairing(db, owner), current = await createPairing(db, owner);
  assert.notEqual(old.code, current.code);
  await assert.rejects(redeemPairing(db, {code: old.code}), invalid);
  await assert.rejects(redeemPairing(db, {code: 'AAAAA-AAAAA-AAAAA-AAAAA'}), invalid);
  await assert.rejects(redeemPairing(db, {code: '123456'}), invalid);
  await assert.rejects(redeemPairing(db, {code: current.code, roomId: 'attacker'}), invalid);
  sqlite.prepare('UPDATE pairing_codes SET expires_at = ?').run(new Date(Date.now() - 1).toISOString());
  await assert.rejects(redeemPairing(db, {code: current.code}), invalid);
  const fresh = await createPairing(db, owner);
  await redeemPairing(db, {code: fresh.code});
  await assert.rejects(redeemPairing(db, {code: fresh.code}), invalid);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM agents').get()!.n, 1);
});

test('simultaneous redemption creates exactly one agent and a failed transaction leaves the code usable', async () => {
  const {db,sqlite,owner} = await fixture();
  const pairing = await createPairing(db, owner);
  sqlite.exec("CREATE TRIGGER fail_pairing BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(redeemPairing(db, {code: pairing.code}));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM pairing_codes').get()!.n, 1);
  sqlite.exec('DROP TRIGGER fail_pairing');
  const outcomes = await Promise.allSettled(Array.from({length: 8}, () => redeemPairing(db, {code: pairing.code})));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM agents').get()!.n, 1);
});

test('pairing endpoints require member authorization, reject cross-origin requests and hide secrets', async () => {
  const {db,room,owner} = await fixture();
  const agent = await createAgent(db, owner, {name:'Agent'});
  await assert.rejects(createPairing(db, await authenticate(db, `Bearer ${agent.token}`, 'agent')));
  const env = { DB: db } as Env;
  const send = (route: string, token?: string, origin?: string, body?: unknown) => worker.fetch(new Request(`https://board.example${route}`, {
    method: 'POST', headers: {'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`} : {}), ...(origin?{Origin:origin}:{})},
    body: JSON.stringify(body ?? {}),
  }), env, {} as ExecutionContext);
  assert.equal((await send('/api/pairing')).status, 401);
  assert.equal((await send('/api/pairing', agent.token)).status, 401);
  assert.equal((await send('/api/pairing', room.token, 'https://evil.example')).status, 403);
  const issued = await send('/api/pairing', room.token);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get('Cache-Control'), 'no-store');
  const pairing = await issued.json() as {code:string};
  assert.equal((await send('/api/pairing/redeem', undefined, 'https://evil.example', {code:pairing.code})).status, 403);
  const redeemed = await send('/api/pairing/redeem', undefined, undefined, {code:pairing.code});
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.headers.get('Cache-Control'), 'no-store');
  assert.equal((await send('/api/pairing/redeem', undefined, undefined, {code:pairing.code})).status, 400);
});

test('installer command is unavailable until the host explicitly configures a published version', async () => {
  for (const pkg of [undefined, '@scope/patchwork-cli@latest', '@scope/patchwork-cli@1.0.0;bad', '@scope/patchwork-cli@1.0.0']) {
    const response = await worker.fetch(new Request('https://board.example/api/config'), {PATCHWORK_CLI_PACKAGE:pkg} as Env, {} as ExecutionContext);
    const config = await response.json() as {cliPackage:string|null};
    assert.equal(config.cliPackage, pkg === '@scope/patchwork-cli@1.0.0' ? pkg : null);
  }
});
