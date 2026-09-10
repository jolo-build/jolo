// Preserve this SQL text exactly: existing databases verify its checksum.
const sql = `ALTER TABLE runs ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
`;

export default sql;
