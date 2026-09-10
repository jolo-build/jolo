-- Provider-facing conversation items and message kinds.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'reasoning', 'tool'));

CREATE TABLE conversation_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT REFERENCES runs(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_message', 'reasoning', 'tool_call', 'tool_result', 'system_note')),
  group_id TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id),
  invocation_id TEXT REFERENCES invocations(id),
  payload TEXT NOT NULL,
  payload_artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX conversation_items_session ON conversation_items(session_id, ordinal);
