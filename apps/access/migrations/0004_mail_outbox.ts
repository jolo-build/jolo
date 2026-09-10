const sql = `CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY NOT NULL REFERENCES team_invitations(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  provider_id TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX mail_outbox_pending ON mail_outbox(state, available_at);
`;

export default sql;
