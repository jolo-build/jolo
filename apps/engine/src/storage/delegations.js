export class DelegationRepository {
  constructor(storage) { this.db = storage.db; }
  models(sessionId) {
    return this.db.query('SELECT alias, selector, name, execution FROM delegation_models WHERE session_id = ? ORDER BY rowid').all(sessionId)
      .map(row => ({ ...row, execution: JSON.parse(row.execution) }));
  }
  addModel(sessionId, model) {
    this.db.query('INSERT INTO delegation_models (session_id, alias, selector, name, execution) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, model.alias, model.selector, model.name, JSON.stringify(model.execution));
  }
  insert({ id, parentRunId, childRunId, requestId, modelAlias, createdAt }) {
    this.db.query('INSERT INTO delegations (id, parent_run_id, child_run_id, request_id, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, parentRunId, childRunId, requestId, modelAlias, createdAt);
  }
  rows(sessionId, { parentRunId = null, id = null, limit = 100 } = {}) {
    return this.db.query(`SELECT d.id, d.parent_run_id AS parentRunId, d.child_run_id AS childRunId,
      d.request_id AS requestId, d.model_alias AS modelAlias, d.created_at AS createdAt
      FROM delegations d JOIN runs r ON r.id = d.parent_run_id WHERE r.session_id = ?
      AND (? IS NULL OR d.parent_run_id = ?) AND (? IS NULL OR d.id = ?)
      ORDER BY d.created_at DESC LIMIT ?`).all(sessionId, parentRunId, parentRunId, id, id, limit);
  }
  parent(childRunId) { return this.db.query('SELECT parent_run_id AS parentRunId FROM delegations WHERE child_run_id = ?').get(childRunId)?.parentRunId ?? null; }
}
