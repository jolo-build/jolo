export default `
CREATE TABLE dialogs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_use_id TEXT,
  input TEXT NOT NULL,
  response TEXT,
  state TEXT NOT NULL CHECK (state IN ('requested', 'answered', 'dismissed', 'cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX dialogs_requested ON dialogs(state) WHERE state = 'requested';
`;
