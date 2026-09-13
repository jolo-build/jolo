const sql = `ALTER TABLE synced_chats ADD COLUMN share_token TEXT;
ALTER TABLE synced_chats ADD COLUMN shared_at INTEGER;
CREATE UNIQUE INDEX synced_chats_share_token ON synced_chats(share_token) WHERE share_token IS NOT NULL;`;
export default sql;
