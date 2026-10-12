import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
const text = z.string().trim().min(1).max(8000);
export const clientSchema = z.enum(['codex', 'claude', 'other']);
export const kindSchema = z.enum(['message', 'request']);
export const acknowledgmentSchema = z.object({
  request_id: z.number().int().positive(),
  response: z.enum(['can_handle', 'cannot_handle', 'need_clarification']),
}).strict();
export type Acknowledgment = {
  agent_id: string; agent_name: string; active: boolean;
  response: z.infer<typeof acknowledgmentSchema>['response'] | null; updated_at: string | null;
};
const repository = z.string().trim().max(500).default('').refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, 'Use an HTTPS repository URL.');
export const createRoomSchema = z.object({
  name, memberName: name, repository,
  creationKey: z.string().max(500).optional(),
});
export const joinSchema = z.object({ name, invite: z.string().min(20).max(200) });
export const agentSchema = z.object({ name, client: clientSchema.default('other') });
export const instructionsSchema = z.object({ instructions: z.string().trim().max(4000), version: z.number().int().nonnegative() });
export const postSchema = z.object({
  body: text, kind: kindSchema.default('message'), replyTo: z.number().int().positive().optional(),
}).strict().refine(data => !(data.replyTo && data.kind === 'request'), 'Start a new thread for a request.');
export type Room = {
  id: string; name: string; repository: string; base_branch: string; owner_id: string;
  invite_hash: string; merger_id: string | null; created_at: string;
  instructions: string; instructions_version: number;
};
export type Actor = { id: string; name: string; kind: 'member' | 'agent'; room: Room; memberId?: string };
export type Message = {
  id: number; room_id: string; author_id: string; author_name: string; author_type: 'member' | 'agent';
  kind: z.infer<typeof kindSchema>; body: string; reply_to: number | null;
  status: 'open' | 'resolved' | null; created_at: string;
  acknowledgments?: Acknowledgment[]; needsHumanIntervention?: boolean;
};
// Historical categories and coordination metadata remain in storage, outside the board contract.
type StoredMessage = Omit<Message, 'kind'> & {
  kind: Message['kind'] | 'note' | 'update' | 'ready' | 'integration';
  claimed_by?: string | null; claimed_name?: string | null; recipient_id?: string | null;
};
function publicMessage(row: StoredMessage): Message {
  const { claimed_by: _legacyId, claimed_name: _legacyName, recipient_id: _legacyRecipient, ...message } = row;
  return { ...message, kind: row.kind === 'request' ? 'request' : 'message' };
}
export type Agent = {
  id: string; room_id: string; member_id: string; name: string; client: z.infer<typeof clientSchema>;
  last_seen_at: string | null; last_hook_at: string | null; revoked: number; created_at: string;
};
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join(' '));
  return result.data;
}
export function publicRoom(room: Room) {
  const { invite_hash: _private, merger_id: _merger, base_branch: _branch, ...safe } = room;
  return safe;
}
export function secret(type: 'm' | 'a' | 'i'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `pw_${type}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function now() { return new Date().toISOString(); }
export function requireOwner(actor: Actor) {
  if (actor.kind !== 'member' || actor.id !== actor.room.owner_id) throw new HttpError(403, 'Only the room owner can do this.');
}
export async function authenticate(db: D1Database, authorization: string | null, type: 'member' | 'agent'): Promise<Actor> {
  const token = authorization?.match(/^Bearer (pw_[ma]_[a-f0-9]{64})$/)?.[1];
  if (!token) throw new HttpError(401, 'Connect with a valid access token.');
  const table = type === 'member' ? 'members' : 'agents';
  const row = await db.prepare(`SELECT id, name, room_id${type === 'agent' ? ', member_id' : ''} FROM ${table} WHERE token_hash = ?${type === 'agent' ? ' AND revoked = 0' : ''}`)
    .bind(await hash(token)).first<{ id: string; name: string; room_id: string; member_id?: string }>();
  if (!row) throw new HttpError(401, 'This access token is invalid or has been revoked.');
  const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(row.room_id).first<Room>();
  if (!room) throw new HttpError(401, 'Room is unavailable.');
  return { id: row.id, name: row.name, kind: type, room, memberId: row.member_id };
}
export async function createRoom(db: D1Database, input: unknown) {
  const data = parse(createRoomSchema, input);
  const id = crypto.randomUUID(), memberId = crypto.randomUUID(), token = secret('m'), invite = secret('i'), time = now();
  await db.batch([
    db.prepare('INSERT INTO rooms (id, name, repository, owner_id, invite_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, data.name, data.repository, memberId, await hash(invite), time),
    db.prepare('INSERT INTO members (id, room_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(memberId, id, data.memberName, await hash(token), time),
  ]);
  return { roomId: id, roomName: data.name, name: data.memberName, memberId, token, invite };
}
export async function joinRoom(db: D1Database, input: unknown) {
  const data = parse(joinSchema, input);
  const room = await db.prepare('SELECT * FROM rooms WHERE invite_hash = ?').bind(await hash(data.invite)).first<Room>();
  if (!room) throw new HttpError(404, 'That invitation is invalid or has expired. Ask the room owner for a new link.');
  const token = secret('m'), memberId = crypto.randomUUID();
  await db.prepare('INSERT INTO members (id, room_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(memberId, room.id, data.name, await hash(token), now()).run();
  return { roomId: room.id, roomName: room.name, name: data.name, memberId, token };
}
export async function rotateInvite(db: D1Database, actor: Actor) {
  requireOwner(actor);
  const invite = secret('i');
  await db.prepare('UPDATE rooms SET invite_hash = ? WHERE id = ?').bind(await hash(invite), actor.room.id).run();
  return { invite };
}
export async function createAgent(db: D1Database, actor: Actor, input: unknown) {
  if (actor.kind !== 'member') throw new HttpError(403, 'Create agent connections in the browser.');
  const data = parse(agentSchema, input), id = crypto.randomUUID(), token = secret('a');
  await db.prepare('INSERT INTO agents (id, room_id, member_id, name, client, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, actor.room.id, actor.id, data.name, data.client, await hash(token), now()).run();
  return { id, token };
}
export async function rotateAgent(db: D1Database, actor: Actor, id: string, revoke = false) {
  const row = await db.prepare('SELECT member_id FROM agents WHERE id = ? AND room_id = ?').bind(id, actor.room.id).first<{member_id: string}>();
  if (!row) throw new HttpError(404, 'Agent not found.');
  if (actor.kind !== 'member' || (actor.id !== row.member_id && actor.id !== actor.room.owner_id)) throw new HttpError(403, 'Only this participant or the room owner can manage the connection.');
  const token = revoke ? null : secret('a');
  await db.prepare('UPDATE agents SET token_hash = ?, revoked = ? WHERE id = ? AND room_id = ?')
    .bind(token ? await hash(token) : null, revoke ? 1 : 0, id, actor.room.id).run();
  return { token };
}
export async function saveInstructions(db: D1Database, actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = parse(instructionsSchema, input);
  const updated = await db.prepare('UPDATE rooms SET instructions = ?, instructions_version = instructions_version + 1 WHERE id = ? AND instructions_version = ? RETURNING instructions, instructions_version')
    .bind(data.instructions, actor.room.id, data.version).first<{instructions:string; instructions_version:number}>();
  if (!updated) throw new HttpError(409, 'Instructions changed in another window. Reload the saved instructions before editing again.');
  return updated;
}
export async function postMessage(db: D1Database, actor: Actor, input: unknown) {
  const data = parse(postSchema, input);
  let parent: number | null = null;
  if (data.replyTo) {
    const message = await db.prepare('SELECT id, reply_to FROM messages WHERE id = ? AND room_id = ?').bind(data.replyTo, actor.room.id).first<Pick<Message, 'id' | 'reply_to'>>();
    if (!message) throw new HttpError(404, 'Thread not found in this room.');
    parent = message.reply_to ?? message.id;
  }
  const message = await db.prepare('INSERT INTO messages (room_id, author_id, author_name, author_type, kind, body, reply_to, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .bind(actor.room.id, actor.id, actor.name, actor.kind, data.kind, data.body, parent, data.kind === 'request' ? 'open' : null, now()).first<StoredMessage>();
  return publicMessage(message!);
}
export async function requestAction(db: D1Database, actor: Actor, id: number, action: 'resolve' | 'reopen') {
  parse(z.enum(['resolve', 'reopen']), action);
  const request = await db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ? AND kind = 'request' AND reply_to IS NULL").bind(id, actor.room.id).first<Message>();
  if (!request) throw new HttpError(404, 'Request not found.');
  // Commit the transition and its cursor-visible reply together. Retries are idempotent.
  await db.batch([
    db.prepare('UPDATE messages SET status = ? WHERE id = ? AND room_id = ? AND status != ?')
      .bind(action === 'resolve' ? 'resolved' : 'open', id, actor.room.id, action === 'resolve' ? 'resolved' : 'open'),
    db.prepare(`INSERT INTO messages (room_id, author_id, author_name, author_type, kind, body, reply_to, created_at)
      SELECT ?, ?, ?, ?, 'message', ?, ?, ? WHERE changes() = 1`)
      .bind(actor.room.id, actor.id, actor.name, actor.kind, action === 'resolve' ? 'Marked this request resolved.' : 'Reopened this request.', id, now()),
  ]);
  return publicMessage((await db.prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?').bind(id, actor.room.id).first<StoredMessage>())!);
}

export async function acknowledgeRequest(db: D1Database, actor: Actor, input: unknown) {
  if (actor.kind !== 'agent') throw new HttpError(403, 'Agents respond using their own connection.');
  const data = parse(acknowledgmentSchema, input);
  const request = await db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ? AND kind = 'request' AND reply_to IS NULL")
    .bind(data.request_id, actor.room.id).first<StoredMessage>();
  if (!request) throw new HttpError(404, 'Request not found.');
  if (request.status !== 'open') throw new HttpError(409, 'Reopen the request before updating a response.');
  const time = now(), label = {can_handle:'Can handle', cannot_handle:'Cannot handle', need_clarification:'Need clarification'}[data.response];
  // A changed response and its broadcast reply commit together; retries do not create chatter.
  await db.batch([
    db.prepare(`INSERT INTO request_acknowledgments (request_id, agent_id, response, updated_at)
      SELECT m.id, a.id, ?, ? FROM messages m JOIN agents a ON a.room_id = m.room_id
      WHERE m.id = ? AND m.room_id = ? AND m.status = 'open' AND a.id = ? AND a.revoked = 0
      ON CONFLICT(request_id, agent_id) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at
      WHERE request_acknowledgments.response != excluded.response`)
      .bind(data.response, time, data.request_id, actor.room.id, actor.id),
    db.prepare(`INSERT INTO messages (room_id, author_id, author_name, author_type, kind, body, reply_to, created_at)
      SELECT ?, ?, ?, 'agent', 'message', ?, ?, ? WHERE changes() = 1`)
      .bind(actor.room.id, actor.id, actor.name, `Request response: ${label}.`, data.request_id, time),
  ]);
  const current = (await withAcknowledgments(db, actor, [publicMessage((await db.prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?')
    .bind(data.request_id, actor.room.id).first<StoredMessage>())!)]))[0];
  if (!current.acknowledgments?.some(a => a.agent_id === actor.id && a.active && a.response === data.response)) {
    throw new HttpError(409, 'The request or connection changed. Read the board and retry if appropriate.');
  }
  return current;
}

async function withAcknowledgments(db: D1Database, actor: Actor, messages: Message[]) {
  const requests = messages.filter(m => m.kind === 'request' && m.reply_to === null);
  if (!requests.length) return messages;
  const [agents, responses] = await Promise.all([
    db.prepare('SELECT id, name, revoked FROM agents WHERE room_id = ? ORDER BY created_at').bind(actor.room.id)
      .all<Pick<Agent, 'id' | 'name' | 'revoked'>>(),
    db.prepare(`SELECT r.* FROM request_acknowledgments r JOIN messages m ON m.id = r.request_id
      WHERE m.room_id = ? AND r.request_id IN (SELECT value FROM json_each(?))`)
      .bind(actor.room.id, JSON.stringify(requests.map(m => m.id)))
      .all<{request_id:number; agent_id:string; response:NonNullable<Acknowledgment['response']>; updated_at:string}>(),
  ]);
  for (const request of requests) {
    const byAgent = new Map(responses.results.filter(r => r.request_id === request.id).map(r => [r.agent_id, r]));
    request.acknowledgments = agents.results.filter(a => !a.revoked || byAgent.has(a.id)).map(a => ({
      agent_id:a.id, agent_name:a.name, active:!a.revoked,
      response:byAgent.get(a.id)?.response ?? null, updated_at:byAgent.get(a.id)?.updated_at ?? null,
    }));
    const active = request.acknowledgments.filter(a => a.active);
    request.needsHumanIntervention = request.status === 'open' && active.length > 0 && active.every(a => a.response === 'cannot_handle');
  }
  return messages;
}

// Derived from explicit responses, never persisted as another request status.
const interventionCondition = `m.kind = 'request' AND m.status = 'open' AND m.reply_to IS NULL
  AND EXISTS (SELECT 1 FROM agents a WHERE a.room_id = m.room_id AND a.revoked = 0)
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.room_id = m.room_id AND a.revoked = 0
    AND NOT EXISTS (SELECT 1 FROM request_acknowledgments r
      WHERE r.request_id = m.id AND r.agent_id = a.id AND r.response = 'cannot_handle'))`;

export async function readMessages(db: D1Database, actor: Actor, after = 0, limit = 100,
  options: { openOnly?: boolean; through?: number; latest?: boolean } = {}) {
  const rows = await db.prepare(`SELECT m.* FROM messages m
    WHERE m.room_id = ? AND m.id > ? AND m.id <= ?
    ${options.openOnly ? "AND m.kind = 'request' AND m.status = 'open' AND m.reply_to IS NULL" : ''}
    ORDER BY m.id ${options.latest ? 'DESC' : 'ASC'} LIMIT ?`)
    .bind(actor.room.id, after, options.through ?? Number.MAX_SAFE_INTEGER, limit + 1).all<StoredMessage>();
  const messages = await withAcknowledgments(db, actor, rows.results.slice(0, limit).map(publicMessage));
  return { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: rows.results.length > limit };
}
export async function snapshot(db: D1Database, actor: Actor, before = 0, filter: 'all' | 'open' | 'intervention' = 'all') {
  const roots = await db.prepare(`SELECT m.* FROM messages m WHERE m.room_id = ? AND m.reply_to IS NULL ${before ? 'AND m.id < ?' : ''} ${filter === 'open' ? "AND m.kind = 'request' AND m.status = 'open'" : filter === 'intervention' ? `AND (${interventionCondition})` : ''} ORDER BY m.id DESC LIMIT 31`)
    .bind(...(before ? [actor.room.id, before] : [actor.room.id])).all<StoredMessage>();
  const selected = roots.results.slice(0, 30), ids = selected.map(m => m.id);
  const replies = ids.length ? (await db.prepare(`SELECT * FROM messages WHERE room_id = ? AND reply_to IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`).bind(actor.room.id, ...ids).all<StoredMessage>()).results : [];
  const [agents, members, count] = await Promise.all([
    db.prepare('SELECT id, room_id, member_id, name, client, last_seen_at, last_hook_at, revoked, created_at FROM agents WHERE room_id = ? ORDER BY created_at').bind(actor.room.id).all<Agent>(),
    db.prepare('SELECT id, name FROM members WHERE room_id = ? ORDER BY created_at').bind(actor.room.id).all<{id:string;name:string}>(),
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${interventionCondition}), 0) AS intervention_count
      FROM messages m WHERE m.room_id = ? AND m.kind = 'request' AND m.status = 'open'`).bind(actor.room.id).first<{count:number; intervention_count:number}>(),
  ]);
  return { room: publicRoom(actor.room), me: {id:actor.id,name:actor.name,kind:actor.kind}, agents: agents.results,
    members: members.results, openRequests: count?.count ?? 0, needsHumanIntervention: count?.intervention_count ?? 0,
    messages: await withAcknowledgments(db, actor, [...selected, ...replies].map(publicMessage)), nextBefore: roots.results.length > 30 ? selected.at(-1)!.id : null, serverTime: now() };
}
