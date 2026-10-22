export default `
CREATE TABLE run_change_events (
  seq INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  payload TEXT NOT NULL
);
CREATE INDEX run_change_events_run ON run_change_events(run_id, seq);
INSERT INTO run_change_events(seq, run_id, payload)
SELECT seq, run_id, payload FROM events WHERE type='files.changed' AND run_id IS NOT NULL;
`;
