// What a conversation's Claude process is doing in the background, read from its `session.activity` snapshot (D1, D3).

/**
 * One task of the process, as `session.activity` carries it.
 * @typedef {{
 *   taskId: string, runId: string | null, toolUseId: string | null, description: string, subagentType: string | null,
 *   phase: string | null, backgrounded: boolean, status: 'running' | 'completed' | 'stopped' | 'failed',
 *   startedAt: string, endedAt: string | null,
 *   usage: { totalTokens: number | null, toolUses: number | null, durationMs: number | null },
 * }} TaskRecord
 * @typedef {{ state: 'idle' | 'working' | 'background', tasks: TaskRecord[], truncated: boolean, updatedAt: string }} Activity
 * @typedef {{ name: string | null, status: 'pending' | 'running' | 'done' | 'failed' }} PhaseStatus
 * @typedef {{
 *   runId: string, tasks: TaskRecord[], agents: number, startedAt: string, endedAt: string | null, running: boolean,
 *   phases: PhaseStatus[], tokens: number | null, large: boolean,
 * }} WorkflowRun
 */

/** A workflow run with more agents than this is badged `Large` (Claude Code's own threshold; a setting in Plan 3). */
export const LARGE_RUN_AGENTS = 25;

const started = (/** @type {TaskRecord} */ task) => Date.parse(task.startedAt);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

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
 * The last `Stop background work` a pane sent: the conversation it was for, whether its reply is still due, and the reply.
 * @typedef {{ requested: number, stopped: number, escalated: boolean }} StopResult
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

/** The tokens the tasks reported, or null when none did: unknown usage is never a 0 (spec §2). */
const tokensOf = (/** @type {TaskRecord[]} */ tasks) => {
  let total = null;
  for (const task of tasks) if (task.usage.totalTokens !== null) total = (total ?? 0) + task.usage.totalTokens;
  return total;
};

/** @param {TaskRecord['status'][]} statuses @returns {PhaseStatus['status']} */
const statusOf = (statuses) => {
  if (statuses.some(status => status === 'failed' || status === 'stopped')) return 'failed';
  if (statuses.includes('running')) return 'running';
  return statuses.length && statuses.every(status => status === 'completed') ? 'done' : 'pending';
};

/** @param {string} runId @param {TaskRecord[]} tasks @returns {WorkflowRun} */
const workflowRun = (runId, tasks) => {
  const running = tasks.some(task => task.status === 'running');
  /** @type {Map<string | null, TaskRecord['status'][]>} */
  const byPhase = new Map();
  let startedAt = tasks[0].startedAt, endedAt = null;
  for (const task of tasks) {
    if (byPhase.has(task.phase)) byPhase.get(task.phase).push(task.status);
    else byPhase.set(task.phase, [task.status]);
    if (started(task) < Date.parse(startedAt)) startedAt = task.startedAt;
    if (task.endedAt && (!endedAt || Date.parse(task.endedAt) > Date.parse(endedAt))) endedAt = task.endedAt;
  }
  const phased = tasks.some(task => task.phase !== null);
  return {
    runId, tasks, agents: tasks.length, running, startedAt,
    endedAt: running ? null : endedAt,
    phases: phased ? [...byPhase].map(([name, statuses]) => ({ name, status: statusOf(statuses) })) : tasks.map(task => ({ name: null, status: statusOf([task.status]) })),
    tokens: tokensOf(tasks),
    large: tasks.length > LARGE_RUN_AGENTS,
  };
};

/**
 * Workflow runs (tasks that share a run id), in the order they started, and the standalone tasks, running first and
 * newest first. One pass over the tasks, so a snapshot of hundreds stays cheap (Review Focus 3).
 * @param {Activity | null} activity
 * @returns {{ runs: WorkflowRun[], tasks: TaskRecord[] }}
 */
export function groupActivity(activity) {
  /** @type {Map<string, TaskRecord[]>} */
  const byRun = new Map();
  const standalone = [];
  for (const task of activity?.tasks ?? []) {
    if (task.runId === null) standalone.push(task);
    else if (byRun.has(task.runId)) byRun.get(task.runId).push(task);
    else byRun.set(task.runId, [task]);
  }
  const runs = [...byRun].map(([runId, tasks]) => workflowRun(runId, tasks)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const rank = (/** @type {TaskRecord} */ task) => task.status === 'running' ? 0 : 1;
  return { runs, tasks: standalone.sort((a, b) => rank(a) - rank(b) || started(b) - started(a)) };
}

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

/** A running task the process was told to keep in the background (D1). */
const background = (/** @type {TaskRecord} */ task) => task.status === 'running' && task.backgrounded;

/**
 * The line above the composer while the process has running background tasks (D1); null when none runs. A foreground
 * subagent is left out: the transcript shows it as a subagent block and the composer's Stop ends it with the turn.
 * @param {Activity | null} activity
 * @param {{ now: number, workflowNames: Map<string, string> }} options
 * @returns {{ text: string, running: number } | null}
 */
export function activityLine(activity, { now, workflowNames }) {
  const running = runningTasks(activity).filter(background);
  if (!running.length) return null;
  const tokens = (/** @type {number | null} */ count) => count === null ? '' : ` · ${formatTokens(count)} tokens`;
  const run = groupActivity(activity).runs.filter(item => item.tasks.some(background)).at(-1);
  if (run) {
    const name = workflowNames.get(run.runId) ?? run.tasks[0].description;
    const active = run.tasks.filter(task => task.status === 'running' && task.phase !== null);
    const phase = active.reduce((newest, task) => !newest || started(task) > started(newest) ? task : newest, null)?.phase;
    const finished = run.tasks.filter(task => task.status !== 'running').length;
    const progress = run.tasks.some(task => task.phase !== null) ? [phase, `${finished}/${run.agents}`].filter(Boolean).join(' ') : plural(run.agents, 'agent');
    return { text: `Workflow ${name}: ${progress}${tokens(run.tokens)}`, running: running.length };
  }
  const since = Math.min(...running.map(started));
  return { text: `Background work: ${plural(running.length, 'task')}${tokens(tokensOf(running))} · ${formatElapsed(now - since)}`, running: running.length };
}

const WORKFLOW_HEAD = /^Workflow (\{.*)$/s;
const headOf = (/** @type {string} */ text) => { const at = text.indexOf('\n'); return at < 0 ? text : text.slice(0, at); };

/** A string field of a call head; `cut` also takes what survived of a value the head's cut ended inside. */
const field = (/** @type {string} */ json, /** @type {string} */ name, cut = false) => {
  const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)(")?`).exec(json);
  if (!match || (!match[2] && !cut)) return undefined;
  const raw = match[2] ? match[1] : match[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  try { return JSON.parse(`"${raw}"`); } catch { return undefined; }
};

/**
 * The name of the workflow a `Workflow` tool block started: its script's `meta.name`, else its script file's name.
 * The head may be cut off (a 200-character preview, a bounded transcript line), so its fields are read loosely.
 * @param {string} toolText
 * @returns {string | null}
 */
export function parseWorkflowName(toolText) {
  const match = WORKFLOW_HEAD.exec(headOf(toolText ?? ''));
  if (!match) return null;
  /** @type {Record<string, any>} */
  let input;
  try { input = JSON.parse(match[1]); }
  catch { input = { script: field(match[1], 'script', true), scriptPath: field(match[1], 'scriptPath') }; }
  const named = typeof input.script === 'string' ? /name\s*:\s*(['"`])([^'"`]+)\1/.exec(input.script) : null;
  if (named) return named[2];
  const file = typeof input.scriptPath === 'string' ? input.scriptPath.split('/').filter(Boolean).at(-1)?.replace(/\.[^.]+$/, '') : '';
  return file || null;
}

/**
 * Each workflow run's name, found best effort (D3): (1) the tool call whose id is one of the run's task tool-use ids,
 * (2) a Workflow message that mentions the run's id, (3) the one Workflow message when exactly one run is open.
 * A run without a name is absent: its card falls back to its first task's description.
 * @param {{ kind: string, text: string }[]} messages
 * @param {{ callId: string, name: string, preview: string }[]} tools
 * @param {WorkflowRun[]} runs
 * @returns {Map<string, string>}
 */
export function workflowNames(messages, tools, runs) {
  /** @type {Map<string, string>} */
  const names = new Map();
  const byCall = new Map(tools.map(tool => [tool.callId, tool]));
  const calls = messages.filter(message => message.kind === 'tool' && WORKFLOW_HEAD.test(headOf(message.text)));
  const claimed = new Set();
  for (const run of runs) {
    let name = null;
    for (const task of run.tasks) {
      const tool = task.toolUseId === null ? undefined : byCall.get(task.toolUseId);
      if (tool && (name = parseWorkflowName(tool.preview))) break;
    }
    const message = name ? undefined : calls.find(call => call.text.includes(run.runId));
    if (message) { claimed.add(message); name = parseWorkflowName(message.text); }
    if (name) names.set(run.runId, name);
  }
  const open = runs.filter(run => run.running);
  if (calls.length === 1 && open.length === 1 && !names.has(open[0].runId) && !claimed.has(calls[0])) {
    const name = parseWorkflowName(calls[0].text);
    if (name) names.set(open[0].runId, name);
  }
  return names;
}
