// Schedules: a prompt posted into a session on an interval — a heartbeat that wakes a task
// so it can check on delegated work and correct course. The next slot is a timestamp on the
// record, not a timer, so a restart loses nothing and a sleeping engine produces one catch-up
// fire rather than a backlog.
const sql = `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  prompt TEXT NOT NULL,
  every_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  fire_count INTEGER NOT NULL DEFAULT 0,
  next_fire_at TEXT NOT NULL,
  last_run_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedules_due ON schedules(state, next_fire_at);
`;

export default sql;
