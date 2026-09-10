-- Core schema. Bodies and raw output live in artifacts; events carry references.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'worktree')),
  path TEXT NOT NULL,
  branch TEXT,
  base_commit TEXT,
  owned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX workspaces_project ON workspaces(project_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sessions_project_updated ON sessions(project_id, updated_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  budgets TEXT NOT NULL DEFAULT '{}',
  usage TEXT NOT NULL DEFAULT '{}',
  verification TEXT,
  pause_reason TEXT,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, request_id)
);
CREATE INDEX runs_session_created ON runs(session_id, created_at);
CREATE INDEX runs_state ON runs(state);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  committed_bytes INTEGER NOT NULL DEFAULT 0,
  finalized_hash TEXT,
  retention_class TEXT NOT NULL DEFAULT 'pinned',
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_session ON artifacts(session_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT REFERENCES runs(id),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  committed_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'streaming' CHECK (status IN ('streaming', 'complete', 'interrupted')),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX messages_run ON messages(run_id, ordinal);

CREATE TABLE invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider_call_id TEXT,
  name TEXT NOT NULL,
  argument_digest TEXT NOT NULL,
  argument_artifact_id TEXT REFERENCES artifacts(id),
  grant_id TEXT,
  state TEXT NOT NULL,
  exit_data TEXT,
  result_artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX invocations_run ON invocations(run_id, id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  through_ordinal INTEGER NOT NULL,
  summary_artifact_id TEXT REFERENCES artifacts(id),
  provider_state TEXT,
  context_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE patches (
  invocation_id TEXT PRIMARY KEY REFERENCES invocations(id),
  manifest_key TEXT NOT NULL,
  status TEXT NOT NULL,
  hashes TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  constraints TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  policy_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  value TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_session_seq ON events(session_id, seq);
