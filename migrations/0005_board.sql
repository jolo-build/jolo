-- Work board: end-of-run notes ("where was I") and per-project "last looked" markers.
ALTER TABLE runs ADD COLUMN note TEXT;
ALTER TABLE projects ADD COLUMN last_viewed_at TEXT;
CREATE INDEX runs_session_updated ON runs(session_id, updated_at);
