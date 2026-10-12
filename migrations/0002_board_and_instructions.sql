-- Keep existing messages and historical Git reports intact during upgrades.
ALTER TABLE rooms ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN instructions_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN recipient_id TEXT REFERENCES agents(id);
ALTER TABLE agents ADD COLUMN last_hook_at TEXT;

CREATE TABLE hook_sessions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_hash TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER NOT NULL DEFAULT 0,
  last_instructions INTEGER NOT NULL DEFAULT 0,
  instructions_version INTEGER NOT NULL DEFAULT -1,
  context_hash TEXT NOT NULL DEFAULT '',
  lease_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, session_hash)
);
CREATE INDEX messages_recipient ON messages(room_id, recipient_id, id);
