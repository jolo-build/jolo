// Preserve this SQL text exactly: existing databases verify its checksum.
const sql = `-- Retain execution/audit records when a user removes a task from history.
ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
CREATE INDEX sessions_history ON sessions(project_id, state, updated_at) WHERE deleted_at IS NULL;
`;

export default sql;
