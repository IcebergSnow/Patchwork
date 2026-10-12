import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
const text = z.string().trim().min(1).max(8000);
export const clientSchema = z.enum(['codex', 'claude', 'other']);
export const kindSchema = z.enum(['note', 'request', 'update']);
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
export const agentSchema = z.object({ name, client: clientSchema, scope: z.string().trim().min(1).max(2000) });
export const instructionsSchema = z.object({ instructions: z.string().trim().max(4000), version: z.number().int().nonnegative() });
export const postSchema = z.object({
  body: text, kind: kindSchema.default('note'), replyTo: z.number().int().positive().optional(),
  recipientId: z.string().uuid().nullable().optional(),
}).refine(data => !(data.replyTo && data.kind === 'request'), 'Start a new thread for a request.');
export type Room = {
  id: string; name: string; repository: string; base_branch: string; owner_id: string;
  invite_hash: string; merger_id: string | null; created_at: string;
  instructions: string; instructions_version: number;
};
export type Actor = { id: string; name: string; kind: 'member' | 'agent'; room: Room; memberId?: string };
export type Message = {
  id: number; room_id: string; author_id: string; author_name: string; author_type: 'member' | 'agent';
  kind: z.infer<typeof kindSchema> | 'ready' | 'integration'; body: string; reply_to: number | null; recipient_id: string | null;
  status: 'open' | 'claimed' | 'resolved' | null; claimed_by: string | null; claimed_name: string | null; created_at: string;
};
export type Agent = {
  id: string; room_id: string; member_id: string; name: string; client: z.infer<typeof clientSchema>;
  scope: string; last_seen_at: string | null; last_hook_at: string | null; revoked: number; created_at: string;
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
export async function event(db: D1Database, actor: Actor, kind: string, summary: string) {
  await db.prepare('INSERT INTO events (room_id, actor_name, kind, summary, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(actor.room.id, actor.name, kind, summary, now()).run();
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
    db.prepare('INSERT INTO events (room_id, actor_name, kind, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, data.memberName, 'room', 'Created the room.', time),
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
  await event(db, { id: memberId, name: data.name, kind: 'member', room }, 'member', 'Joined the room.');
  return { roomId: room.id, roomName: room.name, name: data.name, memberId, token };
}
export async function rotateInvite(db: D1Database, actor: Actor) {
  requireOwner(actor);
  const invite = secret('i');
  await db.prepare('UPDATE rooms SET invite_hash = ? WHERE id = ?').bind(await hash(invite), actor.room.id).run();
  await event(db, actor, 'invite', 'Replaced the room invitation. Existing members retain access.');
  return { invite };
}
export async function createAgent(db: D1Database, actor: Actor, input: unknown) {
  if (actor.kind !== 'member') throw new HttpError(403, 'Create agent connections in the browser.');
  const data = parse(agentSchema, input), id = crypto.randomUUID(), token = secret('a');
  await db.prepare('INSERT INTO agents (id, room_id, member_id, name, client, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, actor.room.id, actor.id, data.name, data.client, data.scope, await hash(token), now()).run();
  await event(db, actor, 'agent', `Created connection for ${data.name}.`);
  return { id, token };
}
export async function rotateAgent(db: D1Database, actor: Actor, id: string, revoke = false) {
  const row = await db.prepare('SELECT member_id FROM agents WHERE id = ? AND room_id = ?').bind(id, actor.room.id).first<{member_id: string}>();
  if (!row) throw new HttpError(404, 'Agent not found.');
  if (actor.kind !== 'member' || (actor.id !== row.member_id && actor.id !== actor.room.owner_id)) throw new HttpError(403, 'Only this participant or the room owner can manage the connection.');
  const token = revoke ? null : secret('a');
  await db.prepare('UPDATE agents SET token_hash = ?, revoked = ?, last_seen_at = NULL, last_hook_at = NULL WHERE id = ? AND room_id = ?')
    .bind(token ? await hash(token) : null, revoke ? 1 : 0, id, actor.room.id).run();
  await event(db, actor, 'agent', revoke ? 'Revoked an agent connection.' : 'Replaced an agent access token.');
  return { token };
}
export async function saveInstructions(db: D1Database, actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = parse(instructionsSchema, input);
  const updated = await db.prepare('UPDATE rooms SET instructions = ?, instructions_version = instructions_version + 1 WHERE id = ? AND instructions_version = ? RETURNING instructions, instructions_version')
    .bind(data.instructions, actor.room.id, data.version).first<{instructions:string; instructions_version:number}>();
  if (!updated) throw new HttpError(409, 'Instructions changed in another window. Reload the saved instructions before editing again.');
  await event(db, actor, 'instructions', data.instructions ? 'Updated custom instructions.' : 'Cleared custom instructions.');
  return updated;
}
export async function updateAgent(db: D1Database, actor: Actor, id: string, input: unknown) {
  const data = parse(z.object({ scope: agentSchema.shape.scope }), input);
  const row = await db.prepare('SELECT member_id FROM agents WHERE id = ? AND room_id = ? AND revoked = 0').bind(id, actor.room.id).first<{member_id:string}>();
  if (!row) throw new HttpError(404, 'Agent not found.');
  if (actor.kind !== 'member' || (actor.id !== row.member_id && actor.id !== actor.room.owner_id)) throw new HttpError(403, 'Only this participant or the room owner can edit the scope.');
  await db.prepare('UPDATE agents SET scope = ? WHERE id = ? AND room_id = ?').bind(data.scope, id, actor.room.id).run();
  return { ok: true };
}
export async function postMessage(db: D1Database, actor: Actor, input: unknown) {
  const data = parse(postSchema, input);
  let parent: number | null = null, recipient = data.recipientId ?? null;
  if (data.replyTo) {
    const message = await db.prepare('SELECT id, reply_to, recipient_id FROM messages WHERE id = ? AND room_id = ?').bind(data.replyTo, actor.room.id).first<Pick<Message, 'id' | 'reply_to' | 'recipient_id'>>();
    if (!message) throw new HttpError(404, 'Thread not found in this room.');
    parent = message.reply_to ?? message.id;
    if (data.recipientId !== undefined && data.recipientId !== message.recipient_id) throw new HttpError(400, 'Replies keep the thread’s recipient.');
    recipient = message.recipient_id;
  } else if (recipient && !(await db.prepare('SELECT id FROM agents WHERE id = ? AND room_id = ? AND revoked = 0').bind(recipient, actor.room.id).first())) {
    throw new HttpError(400, 'Choose an active agent in this room.');
  }
  const message = await db.prepare('INSERT INTO messages (room_id, author_id, author_name, author_type, kind, body, reply_to, status, created_at, recipient_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .bind(actor.room.id, actor.id, actor.name, actor.kind, data.kind, data.body, parent, data.kind === 'request' ? 'open' : null, now(), recipient).first<Message>();
  await event(db, actor, 'message', `${parent ? `Replied to #${parent}` : `Posted ${data.kind} #${message!.id}`}.`);
  return message!;
}
export async function requestAction(db: D1Database, actor: Actor, id: number, action: 'claim' | 'resolve' | 'reopen') {
  const request = await db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ? AND kind = 'request' AND reply_to IS NULL").bind(id, actor.room.id).first<Message>();
  if (!request) throw new HttpError(404, 'Request not found.');
  let updated: Message | null;
  if (action === 'claim') {
    updated = await db.prepare("UPDATE messages SET status = 'claimed', claimed_by = ?, claimed_name = ? WHERE id = ? AND room_id = ? AND status = 'open' RETURNING *")
      .bind(actor.id, actor.name, id, actor.room.id).first<Message>();
    if (!updated) throw new HttpError(409, 'This request has already been claimed or resolved. Refresh the board.');
  } else {
    const owner = actor.kind === 'member' && actor.id === actor.room.owner_id;
    if (!owner && actor.id !== request.author_id && actor.id !== request.claimed_by) throw new HttpError(403, 'Only the requester, claimant, or room owner can change this request.');
    const state = action === 'resolve' ? 'resolved' : 'open';
    updated = await db.prepare('UPDATE messages SET status = ?, claimed_by = CASE WHEN ? = ? THEN NULL ELSE claimed_by END, claimed_name = CASE WHEN ? = ? THEN NULL ELSE claimed_name END WHERE id = ? AND room_id = ? RETURNING *')
      .bind(state, action, 'reopen', action, 'reopen', id, actor.room.id).first<Message>();
  }
  // A reply makes state changes visible to clients using an append-only message cursor.
  await postMessage(db, actor, { body: action === 'claim' ? `Claimed this request: ${actor.name}.` : action === 'resolve' ? 'Marked this request resolved.' : 'Reopened this request.', kind: 'update', replyTo: id });
  return updated!;
}
export async function readMessages(db: D1Database, actor: Actor, after = 0, limit = 100) {
  const rows = await db.prepare('SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ?').bind(actor.room.id, after, limit + 1).all<Message>();
  const messages = rows.results.slice(0, limit);
  return { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: rows.results.length > limit };
}
export async function snapshot(db: D1Database, actor: Actor, before = 0, openOnly = false) {
  const roots = await db.prepare(`SELECT * FROM messages WHERE room_id = ? AND reply_to IS NULL ${before ? 'AND id < ?' : ''} ${openOnly ? "AND kind = 'request' AND status != 'resolved'" : ''} ORDER BY id DESC LIMIT 31`)
    .bind(...(before ? [actor.room.id, before] : [actor.room.id])).all<Message>();
  const selected = roots.results.slice(0, 30), ids = selected.map(m => m.id);
  const replies = ids.length ? (await db.prepare(`SELECT * FROM messages WHERE room_id = ? AND reply_to IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`).bind(actor.room.id, ...ids).all<Message>()).results : [];
  const [agents, members, count] = await Promise.all([
    db.prepare('SELECT id, room_id, member_id, name, client, scope, last_seen_at, last_hook_at, revoked, created_at FROM agents WHERE room_id = ? ORDER BY created_at').bind(actor.room.id).all<Agent>(),
    db.prepare('SELECT id, name FROM members WHERE room_id = ? ORDER BY created_at').bind(actor.room.id).all<{id:string;name:string}>(),
    db.prepare("SELECT COUNT(*) AS count FROM messages WHERE room_id = ? AND kind = 'request' AND status != 'resolved'").bind(actor.room.id).first<{count:number}>(),
  ]);
  return { room: publicRoom(actor.room), me: {id:actor.id,name:actor.name,kind:actor.kind}, agents: agents.results,
    members: members.results, openRequests: count?.count ?? 0,
    messages: [...selected, ...replies], nextBefore: roots.results.length > 30 ? selected.at(-1)!.id : null, serverTime: now() };
}
