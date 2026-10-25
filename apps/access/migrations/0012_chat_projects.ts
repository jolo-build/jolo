// Virtual columns read the portable context every version-2 chat already stores, so existing
// rows group without a backfill and rows written by an older Worker during rollout stay correct.
const sql = `ALTER TABLE synced_chats ADD COLUMN project_id TEXT GENERATED ALWAYS AS (json_extract(content,'$.context.project.id')) VIRTUAL;
ALTER TABLE synced_chats ADD COLUMN project_name TEXT GENERATED ALWAYS AS (json_extract(content,'$.context.project.name')) VIRTUAL;
ALTER TABLE synced_chats ADD COLUMN folder_id TEXT GENERATED ALWAYS AS (json_extract(content,'$.context.workspace.id')) VIRTUAL;
ALTER TABLE synced_chats ADD COLUMN folder_name TEXT GENERATED ALWAYS AS (json_extract(content,'$.context.workspace.name')) VIRTUAL;
ALTER TABLE synced_chats ADD COLUMN folder_branch TEXT GENERATED ALWAYS AS (json_extract(content,'$.context.workspace.branch')) VIRTUAL;
CREATE INDEX synced_chats_project ON synced_chats(account_id, project_id, updated_at);`;
export default sql;
