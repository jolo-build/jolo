export default `
CREATE TABLE session_activity (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
