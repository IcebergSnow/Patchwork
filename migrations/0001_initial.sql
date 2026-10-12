PRAGMA foreign_keys = ON;

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repository TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT 'main',
  owner_id TEXT NOT NULL,
  invite_hash TEXT NOT NULL UNIQUE,
  merger_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  name TEXT NOT NULL,
  client TEXT NOT NULL CHECK(client IN ('codex', 'claude', 'other')),
  scope TEXT NOT NULL DEFAULT '',
  token_hash TEXT UNIQUE,
  branch TEXT NOT NULL DEFAULT '',
  head_commit TEXT NOT NULL DEFAULT '',
  base_commit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  summary TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  reported_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('member', 'agent')),
  kind TEXT NOT NULL CHECK(kind IN ('note', 'request', 'update', 'ready', 'integration')),
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id),
  status TEXT CHECK(status IN ('open', 'claimed', 'resolved')),
  claimed_by TEXT,
  claimed_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  actor_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE integrations (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed')),
  summary TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('agent', 'member'))
);
CREATE INDEX members_room ON members(room_id);
CREATE INDEX agents_room ON agents(room_id);
CREATE INDEX messages_room_cursor ON messages(room_id, id);
CREATE INDEX messages_threads ON messages(room_id, reply_to, id);
CREATE INDEX messages_requests ON messages(room_id, kind, status);
CREATE INDEX events_room_cursor ON events(room_id, id);
