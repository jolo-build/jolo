// SQL for the plans aggregate, sharing Storage's exclusive connection and transactions.
import { newId, now, mapPlan, mapPlanTask, mapPlanExecution } from "./records.js";

export class PlanRepository {
  constructor(storage) { this.storage = storage; this.db = storage.db; }

  insertPlan({ projectId, workspaceId, goal, policy }) {
    const id = newId("pln");
    const at = now();
    this.db.query("INSERT INTO plans (id, project_id, workspace_id, goal, state, policy, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?6)")
      .run(id, projectId, workspaceId, goal, JSON.stringify(policy ?? {}), at);
    return this.getPlan(id);
  }

  getPlan(id) {
    return mapPlan(this.db.query("SELECT * FROM plans WHERE id = ?1").get(id));
  }

  listPlans({ projectId = null, limit = 50 } = {}) {
    const rows = projectId
      ? this.db.query("SELECT * FROM plans WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2").all(projectId, limit)
      : this.db.query("SELECT * FROM plans ORDER BY created_at DESC LIMIT ?1").all(limit);
    return rows.map(mapPlan);
  }

  listPlansByState(states) {
    const marks = states.map((_, index) => `?${index + 1}`).join(", ");
    return this.db.query(`SELECT * FROM plans WHERE state IN (${marks}) ORDER BY created_at`).all(...states).map(mapPlan);
  }

  planTaskCounts(planId) {
    const counts = {};
    for (const row of this.db.query("SELECT state, COUNT(*) AS n FROM plan_tasks WHERE plan_id = ?1 GROUP BY state").all(planId)) counts[row.state] = row.n;
    return counts;
  }

  updatePlanState(id, state, { failure = null } = {}) {
    this.db.query("UPDATE plans SET state = ?1, failure = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?4").run(state, failure, now(), id);
    return this.getPlan(id);
  }

  insertPlanTask({ planId, position, title, brief, agentId = null, model = null, effort = null }) {
    const id = newId("tsk");
    const at = now();
    this.db.query("INSERT INTO plan_tasks (id, plan_id, position, title, brief, agent_id, model, effort, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9)")
      .run(id, planId, position, title, brief, agentId, model, effort, at);
    return this.getPlanTask(id);
  }

  getPlanTask(id) {
    return mapPlanTask(this.db.query("SELECT * FROM plan_tasks WHERE id = ?1").get(id));
  }

  listPlanTasks(planId) {
    return this.db.query("SELECT * FROM plan_tasks WHERE plan_id = ?1 ORDER BY position").all(planId).map(mapPlanTask);
  }

  nextPlanTask(planId) {
    return mapPlanTask(this.db.query("SELECT * FROM plan_tasks WHERE plan_id = ?1 AND state = 'pending' ORDER BY position LIMIT 1").get(planId));
  }

  updatePlanTask(id, fields) {
    const columns = { title: "title", brief: "brief", agentId: "agent_id", model: "model", effort: "effort", position: "position" };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (fields[key] === undefined) continue;
      values.push(fields[key]);
      sets.push(`${column} = ?${values.length}`);
    }
    if (!sets.length) return this.getPlanTask(id);
    values.push(now(), id);
    this.db.query(`UPDATE plan_tasks SET ${sets.join(", ")}, revision = revision + 1, updated_at = ?${values.length - 1} WHERE id = ?${values.length}`).run(...values);
    return this.getPlanTask(id);
  }

  updatePlanTaskState(id, state, { blockedReason = null, sessionId, acceptedExecutionId, summary } = {}) {
    const sets = ["state = ?1", "blocked_reason = ?2", "revision = revision + 1", "updated_at = ?3"];
    const values = [state, blockedReason, now()];
    if (sessionId !== undefined) { values.push(sessionId); sets.push(`session_id = ?${values.length}`); }
    if (acceptedExecutionId !== undefined) { values.push(acceptedExecutionId); sets.push(`accepted_execution_id = ?${values.length}`); }
    if (summary !== undefined) { values.push(summary); sets.push(`summary = ?${values.length}`); }
    values.push(id);
    this.db.query(`UPDATE plan_tasks SET ${sets.join(", ")} WHERE id = ?${values.length}`).run(...values);
    return this.getPlanTask(id);
  }

  deletePlanTask(id) {
    this.db.query("DELETE FROM plan_tasks WHERE id = ?1").run(id);
  }

  insertPlanExecution({ planId, taskId, attempt, purpose, runId = null, sessionId = null, agentId = null, model = null, effort = null }) {
    const id = newId("exe");
    this.db.query("INSERT INTO plan_executions (id, plan_id, task_id, attempt, purpose, run_id, session_id, agent_id, model, effort, started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
      .run(id, planId, taskId, attempt, purpose, runId, sessionId, agentId, model, effort, now());
    return this.getPlanExecution(id);
  }

  getPlanExecution(id) {
    return mapPlanExecution(this.db.query("SELECT * FROM plan_executions WHERE id = ?1").get(id));
  }

  planExecutionForRun(runId) {
    return mapPlanExecution(this.db.query("SELECT * FROM plan_executions WHERE run_id = ?1").get(runId));
  }

  listPlanExecutions(planId) {
    return this.db.query("SELECT * FROM plan_executions WHERE plan_id = ?1 ORDER BY started_at").all(planId).map(mapPlanExecution);
  }

  countPlanExecutions(taskId) {
    return this.db.query("SELECT COUNT(*) AS n FROM plan_executions WHERE task_id = ?1").get(taskId).n;
  }

  setPlanExecutionRun(id, runId) {
    this.db.query("UPDATE plan_executions SET run_id = ?1 WHERE id = ?2").run(runId, id);
    return this.getPlanExecution(id);
  }

  finishPlanExecution(id, { outcome, detail = null, usage = null }) {
    this.db.query("UPDATE plan_executions SET outcome = ?1, detail = ?2, usage = ?3, ended_at = ?4 WHERE id = ?5")
      .run(outcome, detail, JSON.stringify(usage ?? {}), now(), id);
    return this.getPlanExecution(id);
  }
}
