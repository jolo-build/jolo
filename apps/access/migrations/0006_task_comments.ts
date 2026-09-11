const sql = `CREATE TABLE task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  body TEXT NOT NULL CHECK((deleted_at IS NOT NULL AND body = '') OR (length(body) > 0 AND length(CAST(body AS BLOB)) <= 8192)),
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(task_id, author_id, request_id)
);
CREATE INDEX task_comments_history ON task_comments(task_id, id DESC);
`;

export default sql;
