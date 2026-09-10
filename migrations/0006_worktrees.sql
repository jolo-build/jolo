-- Worktree workspaces: per-workspace "last looked" markers and soft removal.
ALTER TABLE workspaces ADD COLUMN last_viewed_at TEXT;
ALTER TABLE workspaces ADD COLUMN removed_at TEXT;
UPDATE workspaces SET last_viewed_at = (SELECT last_viewed_at FROM projects WHERE projects.id = workspaces.project_id) WHERE mode = 'direct';
