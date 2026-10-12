-- Only hashes are stored. Pairing codes expire after ten minutes and are deleted on use.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
