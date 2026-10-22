export default `
ALTER TABLE sessions ADD COLUMN pinned_at TEXT;
CREATE INDEX sessions_pinned ON sessions(pinned_at) WHERE pinned_at IS NOT NULL;
`;
