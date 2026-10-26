// What a conversation's Claude process is doing in the background, read from a `session.activity` snapshot: the line a
// client shows while background work runs, and the tasks that work is. Shared by the terminal client and `jolo`.

/**
 * One task of the process, as `session.activity` carries it. `taskType` is Claude's task type: a workflow is ONE task of
 * type `local_workflow`, named by `workflowName`. An engine from before task types sends neither.
 * @typedef {{
 *   taskId: string, runId: string | null, toolUseId: string | null, description: string, subagentType: string | null,
 *   taskType?: string | null, workflowName?: string | null,
 *   phase: string | null, backgrounded: boolean, status: 'running' | 'completed' | 'stopped' | 'failed',
 *   startedAt: string, endedAt: string | null,
 *   usage: { totalTokens: number | null, toolUses: number | null, durationMs: number | null },
 * }} TaskRecord
 * Claude's own task list as the engine last read it after a task call, with the Jolo run whose call it followed; the
 * terminal client shows none of it.
 * @typedef {{ runId: string, at: number, seq: number,
 *   tasks: { id: string, subject: string, activeForm: string | null, status: 'pending' | 'in_progress' | 'completed' }[] }} ClaudeTaskList
 * @typedef {{ state: 'idle' | 'working' | 'background', tasks: TaskRecord[], truncated: boolean, updatedAt: string, taskList?: ClaudeTaskList | null }} Activity
 */

const started = (/** @type {TaskRecord} */ task) => Date.parse(task.startedAt);
const isWorkflow = (/** @type {TaskRecord} */ task) => task.taskType === "local_workflow";

/** `1 task`, `3 tasks`. @param {number} count @param {string} word */
export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `mm:ss`, or `h:mm:ss` from an hour on; never below zero. @param {number} ms */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

/** @param {Activity | null} activity @returns {TaskRecord[]} */
export const runningTasks = (activity) => activity ? activity.tasks.filter((task) => task.status === "running") : [];

/**
 * The running tasks that are background work: a task the process keeps in the background, and once no turn runs, every
 * task still running (Claude reports it in a turn of its own, whatever its flag). During a turn a foreground subagent is
 * the turn's own, which Stop ends with the turn.
 * @param {Activity | null} activity @returns {TaskRecord[]}
 */
export function backgroundTasks(activity) {
  return runningTasks(activity).filter((task) => task.backgrounded || activity.state === "background");
}

/**
 * The snapshot to keep when a `session.activity` read answers after an event or tick brought a newer one: every source
 * carries the process's one monotonic `updatedAt`, so the read replaces only an older snapshot.
 * @param {Activity | null} current @param {Activity | null} read @returns {Activity | null}
 */
export function newerActivity(current, read) {
  return current && (!read || Date.parse(current.updatedAt) > Date.parse(read.updatedAt)) ? current : read;
}

/**
 * The status line while the process has background work; null when none runs. A running workflow names it, with its own
 * elapsed time and a count of the other background tasks; otherwise the tasks are counted from the oldest one's start.
 * @param {Activity | null} activity @param {{ now: number }} options @returns {{ text: string, running: number } | null}
 */
export function activityLine(activity, { now }) {
  const running = backgroundTasks(activity);
  if (!running.length) return null;
  const workflow = running.filter(isWorkflow).reduce((newest, task) => !newest || started(task) > started(newest) ? task : newest, /** @type {TaskRecord | null} */ (null));
  if (workflow) {
    const others = running.length - 1;
    return { text: `Workflow ${workflow.workflowName ?? workflow.description} · ${formatElapsed(now - started(workflow))}${others ? ` · ${plural(others, "other task")}` : ""}`, running: running.length };
  }
  return { text: `Background work: ${plural(running.length, "task")} · ${formatElapsed(now - Math.min(...running.map(started)))}`, running: running.length };
}
