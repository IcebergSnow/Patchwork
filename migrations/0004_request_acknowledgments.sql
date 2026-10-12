-- Responses are independent of request status and never assign work.
CREATE TABLE request_acknowledgments (
  request_id INTEGER NOT NULL REFERENCES messages(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  response TEXT NOT NULL CHECK (response IN ('can_handle', 'cannot_handle', 'need_clarification')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (request_id, agent_id)
);
