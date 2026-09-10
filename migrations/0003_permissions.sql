-- Permission requests and command recovery bookkeeping.
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tool TEXT NOT NULL,
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired')),
  decision TEXT,
  grant_id TEXT REFERENCES grants(id),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX permissions_run ON permissions(run_id, created_at);
CREATE INDEX permissions_state ON permissions(state);
