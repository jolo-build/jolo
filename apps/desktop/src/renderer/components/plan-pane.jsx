import { useEffect, useMemo, useState } from "react";
import { Icon } from "./icon.jsx";

// A plan of tasks across agents. Written down first, started when the user says so,
// and carried out one task at a time. Everything the panel shows comes from the engine's own records, so a
// plan reads the same here as it does in the terminal.

const MARK = Object.freeze({
  pending: { label: "Waiting", tone: "muted" },
  running: { label: "Working", tone: "busy" },
  blocked: { label: "Needs you", tone: "needs" },
  done: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "needs" },
  skipped: { label: "Skipped", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
});

const BLOCKED = Object.freeze({
  permission: "waiting for your answer",
  declined: "you declined an action",
  failure: "it did not finish",
  interrupted: "the engine restarted",
  budget: "it ran out of budget",
  agent_unavailable: "its agent is not available",
});

/** Who answers a task, in the words the composer uses: its own choice, else the plan's default (§6.6). */
function answerer(task, plan, catalog) {
  const policy = plan?.policy ?? {};
  const agentId = task.agentId ?? policy.agentId ?? null;
  const model = task.model ?? (task.agentId ? null : policy.model) ?? null;
  const name = agentId ? catalog.find((entry) => entry.id === agentId)?.displayName ?? agentId : "Jolo";
  return [name, model].filter(Boolean).join(" · ");
}

function TaskRow({ plan, task, catalog, onCall, onOpen }) {
  const mark = MARK[task.state] ?? { label: task.state, tone: "muted" };
  const editable = ["pending", "blocked", "failed"].includes(task.state) && plan.state !== "cancelled";
  return (
    <li className="plan-task" data-state={task.state}>
      <span className={`plan-mark ${mark.tone}`}>{mark.label}</span>
      <span className="plan-task-title">{task.title}</span>
      <span className="plan-task-agent">{answerer(task, plan, catalog)}</span>
      <span className="plan-task-note">{task.blockedReason ? BLOCKED[task.blockedReason] ?? task.blockedReason : task.summary ?? ""}</span>
      <span className="plan-task-actions">
        {task.sessionId && <button onClick={() => onOpen(task.sessionId)} title="Open this task's conversation">Open</button>}
        {editable && task.state !== "pending" && <button onClick={() => onCall("plan.task.retry", { taskId: task.id })}>Try again</button>}
        {editable && <button onClick={() => onCall("plan.task.skip", { taskId: task.id })}>Skip</button>}
      </span>
    </li>
  );
}

function PlanCard({ plan, catalog, onCall, onOpen }) {
  const tasks = plan.tasks ?? [];
  const done = tasks.filter((task) => task.state === "done").length;
  const running = plan.state === "running";
  return (
    <section className="plan-card" data-plan-state={plan.state}>
      <header>
        <span className="plan-goal">{plan.goal}</span>
        <span className={`plan-mark ${plan.state === "done" ? "good" : plan.state === "running" ? "busy" : plan.state === "failed" ? "needs" : "muted"}`}>{plan.state}</span>
        <span className="plan-count">{done} of {tasks.length}</span>
        <span className="grow" />
        {["draft", "paused", "failed"].includes(plan.state) && tasks.some((task) => task.state === "pending") && (
          <button className="primary" onClick={() => onCall("plan.start", { planId: plan.id })}>{plan.state === "draft" ? "Start" : "Carry on"}</button>
        )}
        {running && <button onClick={() => onCall("plan.pause", { planId: plan.id })}>Pause</button>}
        {!["done", "cancelled"].includes(plan.state) && <button onClick={() => onCall("plan.cancel", { planId: plan.id })}>Cancel</button>}
      </header>
      {plan.failure && <p className="plan-failure">{plan.failure}</p>}
      <ol className="plan-tasks">
        {tasks.map((task) => <TaskRow key={task.id} plan={plan} task={task} catalog={catalog} onCall={onCall} onOpen={onOpen} />)}
      </ol>
    </section>
  );
}

/** Writing a plan down: a goal, and a task per line as "title: what to do". */
function NewPlan({ catalog, onCreate, onCancel }) {
  const [goal, setGoal] = useState("");
  const [lines, setLines] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const tasks = useMemo(() => lines.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf(":");
    return at > 0 ? { title: line.slice(0, at).trim(), brief: line.slice(at + 1).trim() } : { title: line.slice(0, 60), brief: line };
  }), [lines]);
  const ready = goal.trim().length > 0 && tasks.length > 0 && !busy;
  return (
    <form
      className="plan-new"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        setBusy(true);
        try { await onCreate({ goal: goal.trim(), tasks, policy: agentId ? { agentId } : undefined }); setGoal(""); setLines(""); }
        finally { setBusy(false); }
      }}
    >
      <label>Goal<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What the plan is for" aria-label="Plan goal" /></label>
      <label>Tasks, one per line<textarea value={lines} onChange={(event) => setLines(event.target.value)} rows={4} placeholder={"write the tests: cover the parser\nmake them pass: fix what they catch"} aria-label="Plan tasks" /></label>
      <label>Answered by
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)} aria-label="Who answers these tasks">
          <option value="">Jolo</option>
          {catalog.filter((entry) => entry.transport !== "pty" && entry.available).map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}{entry.model ? ` · ${entry.model}` : ""}</option>)}
        </select>
      </label>
      <div className="plan-new-actions">
        <span className="muted">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
        <span className="grow" />
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={!ready}>Write it down</button>
      </div>
    </form>
  );
}

export function PlanPane({ projectId, plans, catalog, call, refresh, onOpenSession }) {
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { void refresh(); }, [projectId, refresh]);

  const onCall = async (method, params) => {
    setError(null);
    try { await call(method, params); await refresh(); }
    catch (failure) { setError(failure.message); }
  };
  const onCreate = async ({ goal, tasks, policy }) => {
    setError(null);
    try { await call("plan.create", { projectId, goal, tasks, ...(policy ? { policy } : {}) }); setWriting(false); await refresh(); }
    catch (failure) { setError(failure.message); }
  };

  return (
    <div className="plan-pane">
      <div className="plan-pane-head">
        <span>Plans</span>
        <span className="grow" />
        {!writing && <button className="primary" onClick={() => setWriting(true)}><Icon name="plus" size={13} />New plan</button>}
      </div>
      {error && <p className="plan-failure" role="alert">{error}</p>}
      {writing && <NewPlan catalog={catalog} onCreate={onCreate} onCancel={() => setWriting(false)} />}
      {!writing && plans.length === 0 && <p className="muted plan-empty">No plans yet. A plan is a list of tasks, each answered by the agent you choose, carried out one at a time.</p>}
      {plans.map((plan) => <PlanCard key={plan.id} plan={plan} catalog={catalog} onCall={onCall} onOpen={onOpenSession} />)}
    </div>
  );
}
