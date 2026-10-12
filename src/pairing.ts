import { z } from 'zod';
import { hash, HttpError, now, parse, secret, type Actor } from './domain';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const redeemSchema = z.object({ code: z.string().trim().max(40) }).strict();

export async function createPairing(db: D1Database, actor: Actor) {
  if (actor.kind !== 'member') throw new HttpError(403, 'Pairing requires a room member.');
  // 100 random bits: safe to redeem without a member token, unlike short numeric PINs.
  const code = Array.from(crypto.getRandomValues(new Uint8Array(20)), b => alphabet[b & 31]).join('');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').bind(now()),
    db.prepare(`INSERT INTO pairing_codes (code_hash, room_id, member_id, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(member_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
      .bind(await hash(code), actor.room.id, actor.id, expiresAt),
  ]);
  return { code: code.match(/.{5}/g)!.join('-'), expiresAt };
}

export async function redeemPairing(db: D1Database, input: unknown) {
  const { code } = parse(redeemSchema, input);
  const normalized = code.toUpperCase().replace(/[\s-]/g, '');
  const invalid = () => new HttpError(400, 'Pairing code is invalid, expired, or already used. Get a new code in Room settings.');
  if (!/^[A-HJ-NP-Z2-9]{20}$/.test(normalized)) throw invalid();
  const codeHash = await hash(normalized), id = crypto.randomUUID(), token = secret('a'), tokenHash = await hash(token), time = now();
  // D1 batch is transactional. A competing redemption cannot create a second agent,
  // and a failed insert rolls back without consuming the code.
  const [created] = await db.batch([
    db.prepare(`INSERT INTO agents (id, room_id, member_id, name, client, token_hash, created_at)
      SELECT ?, p.room_id, p.member_id, substr(m.name, 1, 72) || ' / Codex', 'codex', ?, ?
      FROM pairing_codes p JOIN members m ON m.id = p.member_id AND m.room_id = p.room_id
      WHERE p.code_hash = ? AND p.expires_at > ?`)
      .bind(id, tokenHash, time, codeHash, time),
    db.prepare('DELETE FROM pairing_codes WHERE code_hash = ? AND changes() = 1').bind(codeHash),
  ]);
  if (created.meta.changes !== 1) throw invalid();
  const agent = await db.prepare(`SELECT a.name, a.room_id AS roomId, r.name AS roomName
    FROM agents a JOIN rooms r ON r.id = a.room_id WHERE a.id = ?`)
    .bind(id).first<{ name: string; roomId: string; roomName: string }>();
  return { id, token, ...agent! };
}
