// Preserve this SQL text exactly: existing databases verify its checksum.
const sql = `-- Replay events may be retired without erasing review history.
CREATE TABLE run_event_summary (run_id TEXT PRIMARY KEY REFERENCES runs(id), last_at TEXT NOT NULL);
CREATE TABLE run_changed_paths (run_id TEXT NOT NULL REFERENCES runs(id), path TEXT NOT NULL, PRIMARY KEY(run_id, path));
CREATE TABLE run_tool_activity (
  invocation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL,
  at TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE INDEX run_tool_activity_recent ON run_tool_activity(run_id, seq DESC);
CREATE INDEX grants_workspace_scope ON grants(scope, json_extract(constraints, '$.workspaceId'), expires_at);
CREATE INDEX grants_run ON grants(json_extract(constraints, '$.runId'));
CREATE INDEX items_turn_groups ON conversation_items(session_id, kind, group_id);
CREATE INDEX events_run_type_seq ON events(run_id, type, seq);
CREATE INDEX invocations_grant ON invocations(grant_id);
CREATE INDEX permissions_grant ON permissions(grant_id);
`;

export default sql;
