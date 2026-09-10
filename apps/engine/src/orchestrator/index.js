// Plans: work split into ordered tasks, each answered by the agent the user chose for it.
//
// The shape here is deliberately the small one. Tasks run ONE AT A TIME, in order, in a single workspace the
// plan owns. That is what makes a plan honest without any of the machinery parallel work would need: a later
// task sees what the earlier ones did, because it works on the same files; nothing has to be merged; and
// there is never a question about which task a change belongs to.
//
// A task is the unit of work and outlives any single try at it. Each try is an execution, tied to the run
// that carried it out, so a task can be retried or handed to a different agent without losing what happened.
//
// The orchestrator decides WHAT to ask and WHO to ask; it never decides whether an action is allowed. A task
// whose run stops for a permission nobody answered is blocked, and the plan waits for the user, exactly as a
// single task does today.
import { ProtocolError, PlanPolicySchema, PLAN_TASK_DRAFT_LIMIT } from "@jolo/protocol";

/** How a run's ending translates into the state of the task it was carrying out. */
const OUTCOME = Object.freeze({
  completed: { task: "done", outcome: "completed" },
  failed: { task: "failed", outcome: "failed", blocked: "failure" },
  cancelled: { task: "cancelled", outcome: "cancelled" },
  interrupted: { task: "blocked", outcome: "interrupted", blocked: "interrupted" },
  paused: { task: "blocked", outcome: "paused" },
});

const PAUSE_BLOCKED = Object.freeze({ permission: "permission", user: "declined", budget: "budget" });

/**
 * @param {{ storage: any, runs: any, catalog: any, log: any }} deps
 */
export function createOrchestrator({ storage, runs, catalog, log }) {
  /** Plans currently being pumped, so a settled run cannot start two tasks at once. */
  const pumping = new Set();

  const emit = (type, payload) => storage.appendEvent({ type, payload });

  const publishPlan = (plan) => {
    emit("plan.state", { planId: plan.id, state: plan.state, revision: plan.revision, failure: plan.failure });
    return plan;
  };

  const publishTask = (task, extra = {}) => {
    emit("plan.task.state", {
      planId: task.planId, taskId: task.id, state: task.state, revision: task.revision,
      blockedReason: task.blockedReason, sessionId: task.sessionId, summary: task.summary, ...extra,
    });
    return task;
  };

  const requirePlan = (planId) => {
    const plan = storage.getPlan(planId);
    if (!plan) throw new ProtocolError("not_found", `unknown plan ${planId}`);
    return plan;
  };

  const requireTask = (taskId) => {
    const task = storage.getPlanTask(taskId);
    if (!task) throw new ProtocolError("not_found", `unknown task ${taskId}`);
    return task;
  };

  /** What a task should be answered with: its own choice, else the plan's default, else the agent's own. */
  const resolveExecution = (plan, task) => {
    const agentId = task.agentId ?? plan.policy.agentId ?? null;
    const model = task.model ?? (task.agentId ? null : plan.policy.model) ?? null;
    const effort = task.effort ?? (task.agentId ? null : plan.policy.effort) ?? null;
    return { agentId, model, effort };
  };

  /** An agent a task names must still be in the catalog and able to answer as a task, or nothing can start. */
  const checkAgent = (agentId) => {
    if (!agentId) return null;
    let manifest;
    try { manifest = catalog.get(agentId); }
    catch { throw new ProtocolError("invalid_params", `no agent called ${agentId} is in the catalog`); }
    if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a terminal and cannot answer a task`);
    return manifest;
  };

  const settle = (plan, state, { failure = null } = {}) => publishPlan(storage.updatePlanState(plan.id, state, { failure }));

  /**
   * Start the next pending task, or settle the plan when there is nothing left to do. Called after a plan
   * starts and after every run of its own that stops; never runs twice at once for one plan.
   */
  const pump = (planId) => {
    if (pumping.has(planId)) return;
    pumping.add(planId);
    try {
      const plan = storage.getPlan(planId);
      if (!plan || plan.state !== "running") return;
      const tasks = storage.listPlanTasks(planId);
      if (tasks.some((task) => task.state === "running")) return; // one task at a time, always
      const blocked = tasks.find((task) => task.state === "blocked");
      if (blocked) return void settle(plan, "paused"); // the user has something to answer before anything else moves
      const failed = tasks.find((task) => task.state === "failed");
      if (failed && plan.policy.stopOnFailure !== false) {
        return void settle(plan, "failed", { failure: `${failed.title}: ${failed.summary ?? "the task failed"}`.slice(0, 600) });
      }
      const next = storage.nextPlanTask(planId);
      if (!next) {
        // Done means every task was carried out or deliberately passed over. Anything else stopped short.
        const unfinished = tasks.filter((task) => !["done", "skipped"].includes(task.state));
        return void settle(plan, unfinished.length ? "paused" : "done");
      }
      startTask(plan, next);
    } catch (error) {
      log.error("a plan could not go on", { planId, error: String(error?.message ?? error) });
      const plan = storage.getPlan(planId);
      if (plan && plan.state === "running") settle(plan, "paused", { failure: String(error?.message ?? error).slice(0, 600) });
    } finally {
      pumping.delete(planId);
    }
  };

  /** Put one task in front of its agent: a session of its own, an execution on the record, and a run. */
  const startTask = (plan, task) => storage.transaction(() => {
    const { agentId, model, effort } = resolveExecution(plan, task);
    try { checkAgent(agentId); }
    catch (error) {
      const stopped = storage.updatePlanTaskState(task.id, "blocked", { blockedReason: "agent_unavailable", summary: String(error?.message ?? error).slice(0, 600) });
      publishTask(stopped);
      return void settle(plan, "paused");
    }
    // One session per task, reused by every later try, so the agent keeps the thread it was working in.
    let sessionId = task.sessionId;
    if (!sessionId) {
      const session = storage.transaction(() => {
        const created = storage.createSession({ projectId: plan.projectId, workspaceId: plan.workspaceId, title: task.title, agentId, planTaskId: task.id });
        storage.appendEvent({ sessionId: created.id, type: "session.created", payload: { session: created } });
        return created;
      });
      sessionId = session.id;
    }
    const attempt = storage.countPlanExecutions(task.id) + 1;
    const execution = storage.insertPlanExecution({
      planId: plan.id, taskId: task.id, attempt, purpose: attempt === 1 ? "implement" : "retry",
      sessionId, agentId, model, effort,
    });
    const started = storage.updatePlanTaskState(task.id, "running", { sessionId, summary: null });
    publishTask(started, { executionId: execution.id });
    try {
      const run = storage.transaction(() => {
        const { run } = runs.start({
        sessionId, requestId: execution.id, prompt: task.brief,
        execution: model || effort ? { model: model ?? null, effort: effort ?? null } : undefined,
      });
        storage.setPlanExecutionRun(execution.id, run.id);
        return run;
      });
      log.info("plan task started", { planId: plan.id, taskId: task.id, runId: run.id, agentId: agentId ?? "jolo", attempt });
    } catch (error) {
      storage.finishPlanExecution(execution.id, { outcome: "failed", detail: String(error?.message ?? error).slice(0, 600) });
      const stopped = storage.updatePlanTaskState(task.id, "failed", { blockedReason: "failure", summary: String(error?.message ?? error).slice(0, 600) });
      publishTask(stopped);
      settle(plan, "failed", { failure: `${task.title}: ${stopped.summary}`.slice(0, 600) });
    }
  });

  /** A run of ours has stopped: write down how it ended, then see whether the plan can go on. */
  const onRunSettled = (run) => storage.transaction(() => {
    // An engine on its way out is not a decision about the work. Leaving the task as it stands lets the next
    // boot call it interrupted, which is the truth, rather than cancelled, which would blame the user (§14.4).
    if (runs.isStopping) return;
    const execution = storage.planExecutionForRun(run.id);
    if (!execution || execution.endedAt) return;
    const task = storage.getPlanTask(execution.taskId);
    const plan = task && storage.getPlan(task.planId);
    if (!task || !plan) return;
    const mapped = OUTCOME[run.state] ?? OUTCOME.failed;
    const detail = run.failure ?? run.note?.summary ?? null;
    storage.finishPlanExecution(execution.id, { outcome: mapped.outcome, detail: detail?.slice(0, 600) ?? null, usage: run.usage ?? null });

    let state = mapped.task;
    let blockedReason = mapped.blocked ?? null;
    if (run.state === "paused") blockedReason = PAUSE_BLOCKED[run.pauseReason] ?? "declined";
    // A task that failed and may still be tried again goes back in the queue rather than stopping the plan.
    const attempts = storage.countPlanExecutions(task.id);
    if (state === "failed" && attempts < (plan.policy.maxAttempts ?? 1)) { state = "pending"; blockedReason = null; }
    const summary = state === "done" ? (run.note?.summary ?? null) : detail;
    const updated = storage.updatePlanTaskState(task.id, state, {
      blockedReason,
      summary: summary?.slice(0, 600) ?? null,
      ...(state === "done" ? { acceptedExecutionId: execution.id } : {}),
    });
    publishTask(updated, { runId: run.id, executionId: execution.id });
    if (plan.state === "running") storage.afterCommit(() => pump(plan.id));
    else if (plan.state === "paused" || plan.state === "cancelled") log.info("plan task finished after the plan stopped", { planId: plan.id, taskId: task.id, state: updated.state });
  });

  runs.settled.on("run", run => {
    try { onRunSettled(run); }
    catch (error) {
      log.error("could not record how a plan task ended", { runId: run?.id, error: String(error) });
      // Retry the atomic transition once. If storage is still unavailable, pause
      // visibly rather than leaving the plan claiming an executor is running.
      queueMicrotask(() => {
        try { onRunSettled(run); }
        catch (failure) {
          try {
            storage.transaction(() => {
              const execution = storage.planExecutionForRun(run.id);
              if (!execution) return;
              const task = storage.getPlanTask(execution.taskId);
              const plan = storage.getPlan(execution.planId);
              const stopped = storage.updatePlanTaskState(task.id, "blocked", { blockedReason: "failure", summary: "Could not record task completion; reopen and retry." });
              publishTask(stopped);
              settle(plan, "paused");
            });
          } catch (unavailable) { log.error("plan recovery requires storage recovery", { runId: run.id, error: String(unavailable) }); }
        }
      });
    }
  });

  return {
    /** Write a plan down. Nothing is started, and nothing is asked of any agent, until the user says so. */
    create({ projectId, workspaceId, goal, tasks, policy }) {
      const project = storage.getProject(projectId);
      if (!project) throw new ProtocolError("not_found", `unknown project ${projectId}`);
      const workspace = workspaceId ? storage.getWorkspace(workspaceId) : storage.directWorkspace(projectId);
      if (!workspace) throw new ProtocolError("not_found", "this project has no workspace to work in");
      if (workspace.removedAt) throw new ProtocolError("conflict", "that worktree was removed; pick another workspace for this plan");
      if (workspace.projectId !== projectId) throw new ProtocolError("invalid_params", "that workspace belongs to another project");
      const resolved = PlanPolicySchema.parse(policy ?? {});
      checkAgent(resolved.agentId);
      for (const draft of tasks) checkAgent(draft.agentId ?? null);
      return storage.transaction(() => {
        const plan = storage.insertPlan({ projectId, workspaceId: workspace.id, goal, policy: resolved });
        const written = tasks.map((draft, position) => storage.insertPlanTask({
          planId: plan.id, position, title: draft.title, brief: draft.brief,
          agentId: draft.agentId ?? null, model: draft.model ?? null, effort: draft.effort ?? null,
        }));
        storage.appendEvent({ type: "plan.created", payload: { plan, tasks: written } });
        log.info("plan written", { planId: plan.id, tasks: written.length, workspaceId: workspace.id });
        return { plan, tasks: written };
      });
    },

    list({ projectId, limit, includeTasks = false }) {
      return storage.listPlans({ projectId: projectId ?? null, limit }).map((plan) => ({ ...plan, counts: storage.planTaskCounts(plan.id), ...(includeTasks ? { tasks: storage.listPlanTasks(plan.id) } : {}) }));
    },

    get(planId) {
      const plan = requirePlan(planId);
      return { plan, tasks: storage.listPlanTasks(planId), executions: storage.listPlanExecutions(planId) };
    },

    /** Begin, or take up again after a pause. The first pending task goes to its agent straight away. */
    start({ planId, expectedRevision }) {
      const plan = requirePlan(planId);
      if (expectedRevision !== undefined && expectedRevision !== plan.revision) {
        throw new ProtocolError("conflict", `plan revision is ${plan.revision}, expected ${expectedRevision}`, { revision: plan.revision });
      }
      if (plan.state === "running") return { plan };
      if (["cancelled", "done"].includes(plan.state)) throw new ProtocolError("conflict", `this plan is ${plan.state}`, { state: plan.state });
      const tasks = storage.listPlanTasks(planId);
      if (tasks.some((task) => task.state === "blocked")) {
        throw new ProtocolError("conflict", "a task is waiting on you; answer it or skip the task before starting the plan again");
      }
      if (!tasks.some((task) => task.state === "pending")) throw new ProtocolError("conflict", "this plan has no task left to do");
      const running = publishPlan(storage.updatePlanState(planId, "running", { failure: null }));
      pump(planId);
      return { plan: storage.getPlan(planId) ?? running };
    },

    /** Stop giving out work. A task already in front of an agent is left to finish (§6.6). */
    pause(planId) {
      const plan = requirePlan(planId);
      if (["done", "cancelled", "failed"].includes(plan.state)) return { plan };
      return { plan: publishPlan(storage.updatePlanState(planId, "paused")) };
    },

    /** Give up on the plan: the task in flight is cancelled, and nothing pending will be asked for. */
    cancel(planId) {
      const plan = requirePlan(planId);
      if (["done", "cancelled"].includes(plan.state)) return { plan };
      for (const task of storage.listPlanTasks(planId)) {
        if (task.state === "running") {
          const execution = storage.listPlanExecutions(planId).findLast((entry) => entry.taskId === task.id && !entry.endedAt);
          if (execution?.runId) { try { runs.cancel({ runId: execution.runId }); } catch { /* already stopped */ } }
        }
        if (["pending", "blocked", "failed"].includes(task.state)) publishTask(storage.updatePlanTaskState(task.id, "cancelled", { blockedReason: null }));
      }
      return { plan: publishPlan(storage.updatePlanState(planId, "cancelled")) };
    },

    addTask({ planId, task, position }) {
      const plan = requirePlan(planId);
      if (["done", "cancelled"].includes(plan.state)) throw new ProtocolError("conflict", `this plan is ${plan.state}`);
      checkAgent(task.agentId ?? null);
      const tasks = storage.listPlanTasks(planId);
      if (tasks.length >= PLAN_TASK_DRAFT_LIMIT) throw new ProtocolError("limit_exceeded", `a plan holds at most ${PLAN_TASK_DRAFT_LIMIT} tasks`);
      const at = position === undefined ? tasks.length : Math.min(position, tasks.length);
      return storage.transaction(() => {
        for (const existing of tasks.slice().reverse()) {
          if (existing.position >= at) storage.updatePlanTask(existing.id, { position: existing.position + 1 });
        }
        const written = storage.insertPlanTask({
          planId, position: at, title: task.title, brief: task.brief,
          agentId: task.agentId ?? null, model: task.model ?? null, effort: task.effort ?? null,
        });
        storage.appendEvent({ type: "plan.task.updated", payload: { planId, task: written } });
        return { task: written };
      });
    },

    /** Change a task that has not started. What an agent is already working on is not edited under it. */
    updateTask({ taskId, expectedRevision, ...fields }) {
      const task = requireTask(taskId);
      if (expectedRevision !== undefined && expectedRevision !== task.revision) {
        throw new ProtocolError("conflict", `task revision is ${task.revision}, expected ${expectedRevision}`, { revision: task.revision });
      }
      if (task.state === "running") throw new ProtocolError("conflict", "this task is being worked on; pause the plan or wait for it to finish");
      if (fields.agentId !== undefined) checkAgent(fields.agentId);
      if (fields.position !== undefined) {
        const tasks = storage.listPlanTasks(task.planId).filter((entry) => entry.id !== taskId);
        const at = Math.max(0, Math.min(fields.position, tasks.length));
        storage.transaction(() => {
          storage.updatePlanTask(taskId, { position: -1 }); // out of the way, so the unique order never collides
          tasks.splice(at, 0, task);
          tasks.forEach((entry, index) => { if (entry.position !== index) storage.updatePlanTask(entry.id, { position: index }); });
        });
        delete fields.position;
      }
      const updated = storage.updatePlanTask(taskId, fields);
      emit("plan.task.updated", { planId: updated.planId, task: updated });
      return { task: updated };
    },

    removeTask(taskId) {
      const task = requireTask(taskId);
      if (task.state === "running") throw new ProtocolError("conflict", "this task is being worked on; cancel the plan or wait for it to finish");
      if (storage.countPlanExecutions(taskId) > 0) throw new ProtocolError("conflict", "this task has already been tried; skip it instead, so what happened stays on the record");
      storage.transaction(() => {
        storage.deletePlanTask(taskId);
        for (const entry of storage.listPlanTasks(task.planId)) {
          if (entry.position > task.position) storage.updatePlanTask(entry.id, { position: entry.position - 1 });
        }
      });
      emit("plan.task.updated", { planId: task.planId, task: { ...task, state: "cancelled" } });
      return { taskId };
    },

    /** Put a task that stopped back in the queue. The plan itself still has to be started again. */
    retryTask(taskId) {
      const task = requireTask(taskId);
      if (["running", "pending"].includes(task.state)) throw new ProtocolError("conflict", `this task is already ${task.state}`);
      const updated = storage.updatePlanTaskState(taskId, "pending", { blockedReason: null, summary: null });
      publishTask(updated);
      const plan = storage.getPlan(task.planId);
      if (plan?.state === "running") pump(plan.id);
      return { task: updated };
    },

    /** Leave a task undone on purpose and let the plan move past it. */
    skipTask(taskId) {
      const task = requireTask(taskId);
      if (task.state === "running") throw new ProtocolError("conflict", "this task is being worked on; pause the plan or wait for it to finish");
      const updated = storage.updatePlanTaskState(taskId, "skipped", { blockedReason: null });
      publishTask(updated);
      const plan = storage.getPlan(task.planId);
      if (plan?.state === "running") pump(plan.id);
      return { task: updated };
    },

    /**
     * Plans left running by a previous boot. Their runs were marked interrupted before this ran, so the tasks
     * that were in flight are blocked and their plans wait for the user (§14.4). Nothing is started again on
     * its own: what an interrupted agent did or did not finish is not something the engine can assume.
     */
    reconcile() {
      let paused = 0;
      for (const plan of storage.listPlansByState(["running"])) {
        for (const task of storage.listPlanTasks(plan.id)) {
          if (task.state !== "running") continue;
          const execution = storage.listPlanExecutions(plan.id).findLast((entry) => entry.taskId === task.id && !entry.endedAt);
          if (execution) storage.finishPlanExecution(execution.id, { outcome: "interrupted", detail: "the engine restarted before this task finished" });
          publishTask(storage.updatePlanTaskState(task.id, "blocked", { blockedReason: "interrupted", summary: "the engine restarted before this task finished" }));
        }
        settle(plan, "paused");
        paused += 1;
      }
      return { paused };
    },
  };
}
