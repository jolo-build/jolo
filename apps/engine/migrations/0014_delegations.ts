export default `
CREATE TABLE delegation_models (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  alias TEXT NOT NULL,
  selector TEXT NOT NULL,
  name TEXT NOT NULL,
  execution TEXT NOT NULL,
  PRIMARY KEY (session_id, alias),
  UNIQUE (session_id, selector)
);
CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL REFERENCES runs(id),
  child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  request_id TEXT NOT NULL,
  model_alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (parent_run_id, request_id)
);
CREATE INDEX delegations_parent ON delegations(parent_run_id);
`;
