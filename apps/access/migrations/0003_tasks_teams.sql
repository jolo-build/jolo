ALTER TABLE device_flows ADD COLUMN scope TEXT NOT NULL DEFAULT 'account:read';
ALTER TABLE devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'account:read';

CREATE TABLE teams (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX teams_owner ON teams(owner_id);
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')),
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(team_id, account_id)
);
CREATE INDEX memberships_account ON team_members(account_id, team_id);
CREATE TABLE team_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')),
  expires_at INTEGER NOT NULL,
  accepted_by TEXT REFERENCES accounts(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX invitations_email ON team_invitations(email, expires_at);

CREATE TABLE task_labels (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  team_id TEXT REFERENCES teams(id),
  scope_key TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL CHECK(color IN ('gray','blue','green','yellow','red','purple')),
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(scope_key, name)
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  team_id TEXT REFERENCES teams(id),
  assignee_id TEXT REFERENCES accounts(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','in_progress','in_review','done','canceled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  labels TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(labels)),
  revision INTEGER NOT NULL DEFAULT 1,
  request_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, request_id)
);
CREATE INDEX tasks_personal ON tasks(account_id, team_id, archived_at, id);
CREATE INDEX tasks_team ON tasks(team_id, archived_at, state, id);
CREATE TABLE task_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT REFERENCES teams(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX task_audit_scope ON task_audit(team_id, account_id, id);
