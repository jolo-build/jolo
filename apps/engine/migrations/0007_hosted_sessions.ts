// Preserve this SQL text exactly: existing databases verify its checksum.
const sql = `-- A session may be driven by a hosted third-party agent instead of Jolo's own loop.
-- agent_state carries what the adapter needs to continue that agent's conversation next turn.
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
ALTER TABLE sessions ADD COLUMN agent_state TEXT NOT NULL DEFAULT '{}';
`;

export default sql;
