// Preserve this SQL text exactly: existing databases verify its checksum.
const sql = `-- Plans: work split into ordered tasks, each answered by a chosen agent.
-- A task is the unit of work and outlives any single try at it; an execution is one try, tied to the run
-- that carried it out. Keeping the two apart is what lets a task be retried, reassigned to another agent, or
-- reviewed without losing what happened before.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX plans_project ON plans(project_id, created_at);
CREATE INDEX plans_state ON plans(state);

CREATE TABLE plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  agent_id TEXT,
  model TEXT,
  effort TEXT,
  state TEXT NOT NULL,
  blocked_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  session_id TEXT REFERENCES sessions(id),
  accepted_execution_id TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, position)
);
CREATE INDEX plan_tasks_plan ON plan_tasks(plan_id, position);

CREATE TABLE plan_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES plan_tasks(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  purpose TEXT NOT NULL DEFAULT 'implement',
  run_id TEXT REFERENCES runs(id),
  session_id TEXT REFERENCES sessions(id),
  agent_id TEXT,
  model TEXT,
  effort TEXT,
  outcome TEXT,
  detail TEXT,
  usage TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX plan_executions_task ON plan_executions(task_id, started_at);
CREATE UNIQUE INDEX plan_executions_run ON plan_executions(run_id) WHERE run_id IS NOT NULL;

-- What a run was told to answer with, when a task chose something other than the configured default.
ALTER TABLE runs ADD COLUMN execution TEXT;
-- The task a session was opened for, so a plan's transcripts are findable from either side.
ALTER TABLE sessions ADD COLUMN plan_task_id TEXT;
CREATE INDEX sessions_plan_task ON sessions(plan_task_id);
`;

export default sql;
