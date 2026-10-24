// What a conversation's Claude process is doing in the background, read from its `session.activity` snapshot (D1, D3),
// and the child tasks Jolo delegated from it, listed beside that work.
import { RUNNING } from '@jolo/client/board';
import { TERMINAL } from '@jolo/client/run-state';

/**
 * One task of the process, as `session.activity` carries it. `runId` is the task's own run id (Claude Code gives every
 * task one), not a workflow's. `taskType` is Claude's task type: a workflow is ONE task of type `local_workflow`, named
 * by `workflowName`, and its agents have no tasks of their own. An engine from before task types sends neither.
 * `workflow` is what a workflow's progress last said of its phases and agents (D3): null until Claude reports them, and
 * absent from an engine from before it. `parentTaskId` names the task that started it (a subagent's own command names
 * the subagent), `progress` is its latest progress line and `lastTool` the tool it last used, and `summary` and
 * `outputFile` are what its notification said of its end: each null until Claude says it, absent from an older engine.
 * @typedef {{
 *   taskId: string, runId: string | null, toolUseId: string | null, description: string, subagentType: string | null,
 *   taskType?: string | null, workflowName?: string | null,
 *   phase: string | null, backgrounded: boolean, status: 'running' | 'completed' | 'stopped' | 'failed',
 *   startedAt: string, endedAt: string | null,
 *   usage: { totalTokens: number | null, toolUses: number | null, durationMs: number | null },
 *   workflow?: WorkflowProgress | null,
 *   parentTaskId?: string | null, spawnDepth?: number | null, lastTool?: string | null, progress?: string | null,
 *   summary?: string | null, outputFile?: string | null,
 * }} TaskRecord
 * @typedef {{ index?: number, title: string, agents: number, done: number, running: number, failed: number }} WorkflowPhase
 * @typedef {{ label: string, phase: string | null, phaseIndex?: number | null, state: 'running' | 'done' | 'failed', model: string | null,
 *   tokens: number | null, toolCalls: number | null, durationMs: number | null, resultPreview: string | null }} WorkflowAgent
 * @typedef {{ phases: WorkflowPhase[], agents: { total: number, running: number, done: number, failed: number, list?: WorkflowAgent[] }, current: string | null }} WorkflowProgress
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

const newestFirst = (/** @type {TaskRecord} */ a, /** @type {TaskRecord} */ b) => started(b) - started(a);

/**
 * What the panel's Clear finished hid: each finished task it listed then, by id, with when that task ended.
 * @typedef {Record<string, string | null>} ClearedTasks
 */

/**
 * The panel's two lists (D2): the running tasks, then the finished ones but those Clear finished hid, each newest first,
 * workflows (tasks of type `local_workflow`, one card each) among the rest. Tasks are never grouped by `runId`: every
 * task carries a run id of its own. One pass over the tasks, so a snapshot of hundreds stays cheap (Review Focus 3).
 * @param {Activity | null} activity
 * @param {ClearedTasks} [cleared]
 * @returns {{ running: TaskRecord[], finished: TaskRecord[] }}
 */
export function groupActivity(activity, cleared = {}) {
  /** @type {TaskRecord[]} */
  const running = [];
  /** @type {TaskRecord[]} */
  const finished = [];
  for (const task of activity?.tasks ?? []) {
    if (task.status === 'running') running.push(task);
    else if (!(Object.hasOwn(cleared, task.taskId) && cleared[task.taskId] === task.endedAt)) finished.push(task);
  }
  return { running: running.sort(newestFirst), finished: finished.sort(newestFirst) };
}

/**
 * Clear finished: the finished tasks listed at that moment join those hidden before, each with when it ended, so a task
 * that runs again is listed, and so is one that ended since or ended again.
 * @param {Activity | null} activity
 * @param {ClearedTasks} cleared
 * @returns {ClearedTasks}
 */
export function clearFinished(activity, cleared) {
  const next = { ...cleared };
  for (const task of activity?.tasks ?? []) if (task.status !== 'running') next[task.taskId] = task.endedAt;
  return next;
}

/**
 * A list of the panel (running or finished, as groupActivity gives it) with each task whose parent is listed in it drawn
 * under that parent, one level deep: deeper descendants flatten to the same level under the task at the top, each in the
 * list's own order. A task whose parent is in no list here (the other list, cleared or forgotten), or whose parents name
 * each other, stands at the top. One pass, plus each task's short walk up to the top.
 * @param {TaskRecord[]} tasks
 * @returns {{ task: TaskRecord, nested: boolean }[]}
 */
export function nestTasks(tasks) {
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const topOf = (/** @type {TaskRecord} */ task) => {
    const seen = new Set();
    let at = task;
    while (at.parentTaskId && byId.has(at.parentTaskId)) {
      if (seen.has(at.taskId)) return task; // parents that name each other: nobody's child
      seen.add(at.taskId);
      at = /** @type {TaskRecord} */ (byId.get(at.parentTaskId));
    }
    return at;
  };
  /** @type {TaskRecord[]} */
  const tops = [];
  /** @type {Map<string, TaskRecord[]>} */
  const under = new Map();
  for (const task of tasks) {
    const top = topOf(task);
    if (top === task) tops.push(task);
    else if (under.has(top.taskId)) under.get(top.taskId)?.push(task);
    else under.set(top.taskId, [task]);
  }
  return tops.flatMap(top => [{ task: top, nested: false }, ...(under.get(top.taskId) ?? []).map(task => ({ task, nested: true }))]);
}

/** The last part of a path, `/` or `\` separated; the path itself when it has none. @param {string} path */
const fileName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * What a task's row or card says beyond its kind and status, all as Claude said it: while it runs, its progress line
 * (`now`), else the tool it last used (`tool`, for the status line); once it ended, its notification's summary when that
 * says more than its description, and the file its output was written to (`output`, by name, with the full path).
 * @param {TaskRecord} task
 * @returns {{ now: string | null, tool: string | null, summary: string | null, output: { name: string, path: string } | null }}
 */
export function taskDetail(task) {
  if (task.status === 'running') return { now: task.progress || null, tool: task.progress ? null : task.lastTool || null, summary: null, output: null };
  const summary = task.summary && task.summary !== task.description ? task.summary : null;
  return { now: null, tool: null, summary, output: task.outputFile ? { name: fileName(task.outputFile), path: task.outputFile } : null };
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

const STATUS_WORDS = /** @type {const} */ ({ running: 'Running', completed: 'Completed', stopped: 'Stopped', failed: 'Failed' });

/** A task's status in words, as the panel's rows and cards and the chat's workflow cards say it. @param {TaskRecord['status']} status */
export const statusWord = (status) => STATUS_WORDS[status];

/** What a phase Claude last reported running reads once its workflow has ended: the workflow's own end word. */
const ENDED_PHASE = /** @type {const} */ ({ completed: 'done', stopped: 'stopped', failed: 'failed' });

/**
 * A workflow phase's status: failed once an agent of it failed, running while one runs, done when all of them are, and
 * pending before any started. The last report outlives the workflow: a phase it left running on a workflow that ended
 * takes the workflow's end word (`stopped`, `failed`, or `done` for a completed one), never `running`.
 * @param {WorkflowPhase} phase
 * @param {TaskRecord['status']} [taskStatus] the workflow task's status
 * @returns {PhaseStatus}
 */
export function workflowPhaseStatus(phase, taskStatus = 'running') {
  if (phase.failed > 0) return 'failed';
  if (phase.running > 0) return taskStatus === 'running' ? 'running' : ENDED_PHASE[taskStatus];
  return phase.agents > 0 && phase.done === phase.agents ? 'done' : 'pending';
}

/** @typedef {'pending' | 'running' | 'done' | 'failed' | 'stopped'} PhaseStatus */
const repeat = (/** @type {number} */ count, /** @type {PhaseStatus} */ status) => Array.from({ length: Math.max(0, count) }, () => status);

/**
 * A workflow phase's agents, one square each: done, running, failed, then pending. Claude's progress report counts a
 * phase's agents by status and does not say their order, so the squares are ordered by status, not by agent. Agents it
 * left running on a workflow that ended take the workflow's end word, as the phase does (workflowPhaseStatus).
 * @param {WorkflowPhase} phase
 * @param {TaskRecord['status']} [taskStatus] the workflow task's status
 * @returns {PhaseStatus[]}
 */
export function phaseSquares(phase, taskStatus = 'running') {
  return [
    ...repeat(phase.done, 'done'), ...repeat(phase.running, taskStatus === 'running' ? 'running' : ENDED_PHASE[taskStatus]),
    ...repeat(phase.failed, 'failed'), ...repeat(phase.agents - phase.done - phase.running - phase.failed, 'pending'),
  ];
}

/**
 * Squares in words, their text alternative: `1 done, 1 running, 2 pending`, each status once in the order it first
 * appears, leaving out a status none has.
 * @param {string[]} squares
 */
export function squaresInWords(squares) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const status of squares) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
}

/** Add `item` to the group of `key`. @template K, V @param {Map<K, V[]>} groups @param {K} key @param {V} item */
const group = (groups, key, item) => {
  const items = groups.get(key);
  if (items) items.push(item);
  else groups.set(key, [item]);
};

/**
 * A workflow's listed agents (the latest by index, see the engine's summarizeWorkflow) for each of its phases: those that
 * name the phase's index, then those that name no index but the phase's title; a phase from an engine before phase
 * indexes takes every agent under its title. Null when the engine sent no list (one from before it), so no phase opens.
 * One pass over the list; each phase is then a lookup.
 * @param {TaskRecord} task
 * @returns {((phase: WorkflowPhase) => WorkflowAgent[]) | null}
 */
export function agentsByPhase(task) {
  const list = task.workflow?.agents.list;
  if (!list) return null;
  /** @type {Map<number, WorkflowAgent[]>} */
  const byIndex = new Map();
  /** @type {Map<string | null, WorkflowAgent[]>} */
  const byTitle = new Map();
  /** @type {Map<string | null, WorkflowAgent[]>} */
  const unindexed = new Map();
  for (const agent of list) {
    group(byTitle, agent.phase, agent);
    if (typeof agent.phaseIndex === 'number') group(byIndex, agent.phaseIndex, agent);
    else group(unindexed, agent.phase, agent);
  }
  return (phase) => (typeof phase.index === 'number'
    ? [...(byIndex.get(phase.index) ?? []), ...(unindexed.get(phase.title) ?? [])]
    : byTitle.get(phase.title) ?? []);
}

/**
 * A workflow agent's status: its state as Claude last reported it; one it left running on a workflow that ended takes the
 * workflow's end word, as its square does (phaseSquares).
 * @param {WorkflowAgent} agent
 * @param {TaskRecord['status']} [taskStatus] the workflow task's status
 * @returns {PhaseStatus}
 */
export function agentStatus(agent, taskStatus = 'running') {
  return agent.state === 'running' && taskStatus !== 'running' ? ENDED_PHASE[taskStatus] : agent.state;
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
 * The line above the composer while the process has background work (D1) or a child task works; null when neither does.
 * A running workflow names it, with its phase and finished agents once Claude reported them, its own elapsed time and
 * tokens, and a count of the other background tasks; otherwise it counts the tasks. Working child tasks (`children`,
 * since the oldest of them started, `childrenSince`) are counted after that, or alone name the line.
 * @param {Activity | null} activity
 * @param {{ now: number, children?: number, childrenSince?: number | null }} options
 * @returns {{ text: string, running: number } | null}
 */
export function activityLine(activity, { now, children = 0, childrenSince = null }) {
  const running = backgroundTasks(activity);
  if (!running.length) {
    if (!children) return null;
    return { text: `${plural(children, 'child task')} working${childrenSince === null ? '' : ` · ${formatElapsed(now - childrenSince)}`}`, running: 0 };
  }
  const line = processLine(running, now);
  return children ? { ...line, text: `${line.text} · ${plural(children, 'child task')}` } : line;
}

/** The background-work part of the line (see activityLine). @param {TaskRecord[]} running @param {number} now */
function processLine(running, now) {
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

/**
 * A child task as the board lists it (the parts the panel reads), and its delegation row as `delegation.list` returns it.
 * @typedef {{ sessionId: string, title: string, updatedAt: string, attention?: string | null, answerer?: { displayName?: string, model?: string | null } | null,
 *   run: { id: string, state: string, updatedAt: string, execution?: { model?: string | null } | null } | null }} ChildTask
 * @typedef {{ sessionId: string, runId: string, state: string, activity: string | null, createdAt: string } & Record<string, any>} DelegationRow
 *   `activity` is `idle`, `working` or `background` (null before the engine knows).
 */

/**
 * The conversation's child tasks as the Activity panel lists them: running ones first (a run of theirs is live, or their
 * process still works), then the rest, each newest first. A row's elapsed time runs from its delegation's start, and
 * stops when its run ended; it is blank without a delegation row (a child its own child started). A running child is
 * stopped by cancelling its live run, or the delegation's run while its process works; one that ended has no stop.
 * @param {ChildTask[]} children
 * @param {Map<string, DelegationRow>} delegations by session
 * @param {number} now
 */
export function childRows(children, delegations, now) {
  return children.map(task => {
    const delegation = delegations.get(task.sessionId) ?? null;
    const live = RUNNING.has(task.run?.state);
    const running = live || delegation?.activity === 'working' || delegation?.activity === 'background';
    const since = delegation ? Date.parse(delegation.createdAt) : NaN;
    const until = running ? now : Date.parse(task.run?.updatedAt ?? task.updatedAt);
    const elapsed = Number.isFinite(since) && Number.isFinite(until) ? formatElapsed(until - since) : '';
    // The run to cancel: the board's run while it has not ended (awaiting permission or paused count), else the delegation's while it works.
    const stopRunId = task.run && !TERMINAL.has(task.run.state) ? task.run.id : delegation?.activity === 'working' ? delegation.runId ?? null : null;
    return { task, delegation, running, elapsed, since: running && Number.isFinite(since) ? since : null, stopRunId };
  }).sort((a, b) => Number(b.running) - Number(a.running) || (a.task.updatedAt < b.task.updatedAt ? 1 : a.task.updatedAt > b.task.updatedAt ? -1 : 0));
}
