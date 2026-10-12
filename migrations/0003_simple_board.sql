-- Retain historical categories and metadata while allowing the new Message type.
-- D1 runs migrations in a transaction; defer self-references during the table copy.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE messages_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('member', 'agent')),
  kind TEXT NOT NULL CHECK(kind IN ('message', 'request', 'note', 'update', 'ready', 'integration')),
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages_next(id),
  status TEXT CHECK(status IN ('open', 'resolved')),
  claimed_by TEXT,
  claimed_name TEXT,
  created_at TEXT NOT NULL,
  recipient_id TEXT REFERENCES agents(id)
);
INSERT INTO messages_next (id, room_id, author_id, author_name, author_type, kind, body, reply_to, status, claimed_by, claimed_name, created_at, recipient_id)
SELECT id, room_id, author_id, author_name, author_type, kind, body, reply_to,
  CASE WHEN status = 'claimed' THEN 'open' ELSE status END,
  claimed_by, claimed_name, created_at, recipient_id FROM messages;
-- Do not reuse ids even if an installation previously deleted its newest message.
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'messages'), 0)) WHERE name = 'messages_next';
DROP TABLE messages;
ALTER TABLE messages_next RENAME TO messages;
CREATE INDEX messages_room_cursor ON messages(room_id, id);
CREATE INDEX messages_threads ON messages(room_id, reply_to, id);
CREATE INDEX messages_requests ON messages(room_id, kind, status);
CREATE INDEX messages_recipient ON messages(room_id, recipient_id, id);
PRAGMA defer_foreign_keys = OFF;
