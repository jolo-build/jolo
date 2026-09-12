const sql = `CREATE TABLE synced_chats (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX synced_chats_account ON synced_chats(account_id, id);`;
export default sql;
