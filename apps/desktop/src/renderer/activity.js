// What a conversation's Claude process is doing in the background, read from its `session.activity` snapshot (D1, D3).

/**
 * One task of the process, as `session.activity` carries it. `runId` is the task's own run id (Claude Code gives every
 * task one), not a workflow's. `taskType` is Claude's task type: a workflow is ONE task of type `local_workflow`, named
 * by `workflowName`, and its agents have no tasks of their own. An engine from before task types sends neither.
 * `workflow` is what a workflow's progress last said of its phases and agents (D3): null until Claude reports them, and
 * absent from an engine from before it.
 * @typedef {{
 *   taskId: string, runId: string | null, toolUseId: string | null, description: string, subagentType: string | null,
 *   taskType?: string | null, workflowName?: string | null,
 *   phase: string | null, backgrounded: boolean, status: 'running' | 'completed' | 'stopped' | 'failed',
 *   startedAt: string, endedAt: string | null,
 *   usage: { totalTokens: number | null, toolUses: number | null, durationMs: number | null },
 *   workflow?: WorkflowProgress | null,
 * }} TaskRecord
 * @typedef {{ title: string, agents: number, done: number, running: number, failed: number }} WorkflowPhase
 * @typedef {{ phases: WorkflowPhase[], agents: { total: number, running: number, done: number, failed: number }, current: string | null }} WorkflowProgress
 * @typedef {{ state: 'idle' | 'working' | 'background', tasks: TaskRecord[], truncated: boolean, updatedAt: string }} Activity
 */

/** A workflow with more agents than this is badged `Large` (Claude Code's own threshold; a setting in Plan 3). */
export const LARGE_RUN_AGENTS = 25;

const started = (/** @type {TaskRecord} */ task) => Date.parse(task.startedAt);
const isWorkflow = (/** @type {TaskRecord} */ task) => task.taskType === 'local_workflow';
/** `1 task`, `3 tasks`. @param {number} count @param {string} word */
export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** @param {Activity | null} activity @returns {TaskRecord[]} */
export function runningTasks(activity) {
  return activity ? activity.tasks.filter(task => task.status === 'running') : [];
}

/**
 * The snapshot to keep when a `session.activity` read answers after an event or tick brought a newer one: every source
 * carries the process's one monotonic `updatedAt`, so the read replaces only an older snapshot. Selecting the
 * conversation cleared the activity before the read was sent, so one that is there now is newer than a read of none.
 * @param {Activity | null} current
 * @param {Activity | null} read
 * @returns {Activity | null}
 */
export function newerActivity(current, read) {
  return current && (!read || Date.parse(current.updatedAt) > Date.parse(read.updatedAt)) ? current : read;
}

/**
 * The last `Stop background work` a pane sent: the conversation it was for, whether its reply is still due, and the reply
 * with the ids of the tasks that ran when it was sent, which are the ones a force-stop would be about.
 * @typedef {{ requested: number, stopped: number, escalated: boolean, taskIds: string[] }} StopResult
 * @typedef {{ sessionId: string, pending: boolean, result: StopResult | null }} StopState
 */

/**
 * What the shown conversation sees of that stop: a stop belongs to the conversation that sent it, so its wait and its
 * reply never carry into another one, whose force-stop would otherwise read a reply about a different process.
 * @param {StopState | null} stop
 * @param {string | null} sessionId
 * @returns {{ stopping: boolean, stopResult: StopResult | null }}
 */
export function stopFor(stop, sessionId) {
  return stop?.sessionId === sessionId ? { stopping: stop.pending, stopResult: stop.result } : { stopping: false, stopResult: null };
}

/**
 * Whether to offer the force-stop (D11, Review Focus 4): the stop's reply left work (`escalated` or fewer stopped than
 * requested) and a task that ran when it was sent runs still. Work that started after it is not what it was about.
 * @param {Activity | null} activity
 * @param {StopResult | null} stopResult
 */
export function forceStopOffered(activity, stopResult) {
  return Boolean(stopResult) && (stopResult.escalated || stopResult.stopped < stopResult.requested)
    && runningTasks(activity).some(task => stopResult.taskIds.includes(task.taskId));
}

/** The tokens the tasks reported, or null when none did: unknown usage is never a 0 (spec §2), and the line leaves out a 0 too. */
const tokensOf = (/** @type {TaskRecord[]} */ tasks) => {
  let total = null;
  for (const task of tasks) if (task.usage.totalTokens !== null) total = (total ?? 0) + task.usage.totalTokens;
  return total;
};

/** Running before finished, newest first (D2). */
const byRecency = (/** @type {TaskRecord} */ a, /** @type {TaskRecord} */ b) => Number(b.status === 'running') - Number(a.status === 'running') || started(b) - started(a);

/**
 * The workflows (tasks of type `local_workflow`, one card each) and the other tasks, each running first and newest first.
 * Tasks are never grouped by `runId`: every task carries a run id of its own. One pass over the tasks, so a snapshot of
 * hundreds stays cheap (Review Focus 3).
 * @param {Activity | null} activity
 * @returns {{ workflows: TaskRecord[], tasks: TaskRecord[] }}
 */
export function groupActivity(activity) {
  /** @type {TaskRecord[]} */
  const workflows = [];
  /** @type {TaskRecord[]} */
  const tasks = [];
  for (const task of activity?.tasks ?? []) (isWorkflow(task) ? workflows : tasks).push(task);
  return { workflows: workflows.sort(byRecency), tasks: tasks.sort(byRecency) };
}

/**
 * What kind of task the panel names it: Claude's task type, else an agent when a subagent type is known (an engine from
 * before task types), else a task.
 * @param {TaskRecord} task
 * @returns {'Workflow' | 'Command' | 'Agent' | 'Task'}
 */
export function taskKind(task) {
  if (isWorkflow(task)) return 'Workflow';
  if (task.taskType === 'local_bash') return 'Command';
  return task.taskType === 'local_agent' || task.subagentType ? 'Agent' : 'Task';
}

/** What a phase Claude last reported running reads once its workflow has ended: the workflow's own end word. */
const ENDED_PHASE = /** @type {const} */ ({ completed: 'done', stopped: 'stopped', failed: 'failed' });

/**
 * A workflow phase's dot: failed once an agent of it failed, running while one runs, done when all of them are, and
 * pending before any started. The last report outlives the workflow: a phase it left running on a workflow that ended
 * takes the workflow's end word (`stopped`, `failed`, or `done` for a completed one), never `running`.
 * @param {WorkflowPhase} phase
 * @param {TaskRecord['status']} [taskStatus] the workflow task's status
 * @returns {'pending' | 'running' | 'done' | 'failed' | 'stopped'}
 */
export function workflowPhaseStatus(phase, taskStatus = 'running') {
  if (phase.failed > 0) return 'failed';
  if (phase.running > 0) return taskStatus === 'running' ? 'running' : ENDED_PHASE[taskStatus];
  return phase.agents > 0 && phase.done === phase.agents ? 'done' : 'pending';
}

/**
 * What a workflow's card and the line say of its agents (D3): their count, its phases and the agent the last progress
 * report named, all as Claude's progress last reported them. `agents` is null while it has reported none (nothing is inferred), and `large`
 * past LARGE_RUN_AGENTS.
 * @param {TaskRecord} task
 * @returns {{ agents: number | null, phases: WorkflowPhase[], current: string | null, large: boolean }}
 */
export function workflowSummary(task) {
  const progress = task.workflow;
  if (!progress) return { agents: null, phases: [], current: null, large: false };
  return { agents: progress.agents.total, phases: progress.phases, current: progress.current, large: progress.agents.total > LARGE_RUN_AGENTS };
}

/** The phase the line names: the first with running agents, else the last any agent finished in, else the first. */
const linePhase = (/** @type {WorkflowPhase[]} */ phases) => (phases.find(phase => phase.running > 0)
  ?? phases.findLast(phase => phase.done + phase.failed > 0) ?? phases[0])?.title ?? null;

/** @param {number} n */
export function formatTokens(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** @param {number} ms */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

/**
 * The running tasks that are background work (D1), which the line and the Panels menu both count: a task the process
 * keeps in the background, and once no turn runs, every task still running (Claude reports it in a turn of its own,
 * whatever its flag). During a turn a foreground subagent is the turn's own: the transcript shows it as a subagent block
 * and the composer's Stop ends it with the turn.
 * @param {Activity | null} activity
 * @returns {TaskRecord[]}
 */
export function backgroundTasks(activity) {
  return runningTasks(activity).filter(task => task.backgrounded || activity.state === 'background');
}

/**
 * The line above the composer while the process has background work (D1); null when none runs. A running workflow names
 * it, with its phase and finished agents once Claude reported them, its own elapsed time and tokens, and a count of the
 * other background tasks; otherwise it counts the tasks.
 * @param {Activity | null} activity
 * @param {{ now: number }} options
 * @returns {{ text: string, running: number } | null}
 */
export function activityLine(activity, { now }) {
  const running = backgroundTasks(activity);
  if (!running.length) return null;
  // Unknown usage, and a 0 (no agent or task has reported spend yet), are left out (spec §2).
  const tokens = (/** @type {number | null} */ count) => !count ? '' : ` · ${formatTokens(count)} tokens`;
  const workflow = running.filter(isWorkflow).reduce((newest, task) => !newest || started(task) > started(newest) ? task : newest, /** @type {TaskRecord | null} */ (null));
  if (workflow) {
    const others = running.length - 1;
    const rest = others ? ` · ${plural(others, 'other task')}` : '';
    const progress = workflow.workflow;
    const counts = progress ? `: ${[linePhase(progress.phases), `${progress.agents.done}/${progress.agents.total}`].filter(Boolean).join(' ')}` : '';
    return { text: `Workflow ${workflow.workflowName ?? workflow.description}${counts} · ${formatElapsed(now - started(workflow))}${tokens(workflow.usage.totalTokens)}${rest}`, running: running.length };
  }
  const since = Math.min(...running.map(started));
  return { text: `Background work: ${plural(running.length, 'task')}${tokens(tokensOf(running))} · ${formatElapsed(now - since)}`, running: running.length };
}
