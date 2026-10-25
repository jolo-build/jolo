// A prompt sent from the web to one connected device. `chat_id` continues a synced chat;
// `folder_id` starts a new chat in a synced folder. Text stays here so the page can show it.
// `permission` describes the request a run is waiting on, while it waits.
const sql = `CREATE TABLE remote_prompts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  chat_id TEXT,
  folder_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','accepted','running','awaiting_permission','completed','failed','cancelled','rejected','expired')),
  error TEXT,
  result_chat_id TEXT,
  permission TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((chat_id IS NULL) <> (folder_id IS NULL))
);
CREATE INDEX remote_prompts_chat ON remote_prompts(account_id, chat_id, created_at);
CREATE INDEX remote_prompts_active ON remote_prompts(status, updated_at);`;
export default sql;
