// One Claude Code process per conversation, kept across turns.
//
// Claude Code in streaming-input mode answers as many turns as its host feeds it, and whatever it started in
// the background (subagents, workflows, long commands) keeps running between them. A link is that process for
// one conversation: a run borrows it for a turn and gives it back, and the next run borrows it again. The
// process is closed when the conversation is archived or deleted, when its workspace goes, when it has been
// idle for a long time, when the model or effort it was started with changes, or when the engine stops.
//
// Three things a per-turn process could not do are handled here. Background work survives the end of the
// turn that started it. A turn the process begins by itself (a finished background task makes it answer) is
// kept until a run takes it, so it reaches the conversation as a run of its own. And a turn is ended by
// asking the process to stop (an interrupt), not by killing it.
//
// A background subagent can also ask a question while the main thread is idle: a permission request that names
// the subagent (`request.agent_id`). That needs a run to answer it, but there is no turn of the main thread to
// end or interrupt, so stopping such a run never signals the process.
import path from 'node:path';
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  TASK_HISTORY_LIMIT, TASK_ID_MAX, TASK_PATH_MAX, TASK_TEXT_MAX, WORKFLOW_AGENTS_MAX, WORKFLOW_LABEL_MAX, WORKFLOW_MODEL_MAX, WORKFLOW_PHASES_MAX,
  WORKFLOW_PREVIEW_MAX, WORKFLOW_TITLE_MAX, TASK_OUTPUT_MAX, MCP_SERVERS_MAX,
} from '@jolo/protocol';
import { spawnLineChild } from '../processes/line-child.js';

/** How long an idle process is kept. Long on purpose: the point is that background work gets to finish. */
export const HOSTED_LINK_IDLE_MS = 30 * 60_000;
/**
 * Claude echoes each message it takes up in full (--replay-user-messages), images included: up to four 5 MB images, about
 * 27 MB once encoded, on one line. The default bounds of a hosted process would take that for runaway output and kill it.
 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
/** How long a turn is given to end after an interrupt before the process is closed instead. */
export const INTERRUPT_GRACE_MS = 5_000;
/** How long stopping a task waits for Claude's answer, and stopping background work for its tasks to end. */
export const STOP_TASK_GRACE_MS = 3_000;
/** How long a question to the process (a task's output, the MCP servers' status) waits for its answer. */
export const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
/** How long an empty result is taken as possibly ahead of an answer in the same turn (see claude-stream). */
export const EMPTY_RESULT_GRACE_MS = 20_000;
/** Messages kept from a turn the process started by itself, while no run is listening. */
const BUFFER_LIMIT = 20_000;
/** The calls that run a subagent (a skill run in a fork does too), whose subagents are traced. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'Skill']);
/** What a task its process left running says of its end, when the process is gone without a word about it. */
export const ENDED_SUMMARY = 'The process ended before it finished';

/**
 * A conversation's stored activity as it reads once its process is gone: idle, and each task the snapshot still had
 * running stopped, at the snapshot's time, with ENDED_SUMMARY unless it had a summary of its own. The stored snapshot is
 * left as it was.
 * @param {{ state: string, tasks: TaskRecord[], updatedAt: string, truncated?: boolean }} activity
 */
export function endedActivity(activity) {
  return {
    ...activity, state: 'idle',
    tasks: activity.tasks.map((task) => (task.status === 'running' ? { ...task, status: /** @type {const} */ ('stopped'), endedAt: activity.updatedAt, summary: task.summary ?? ENDED_SUMMARY } : task)),
  };
}

/** How long the turn reporting finished background work may take to begin, while it still counts as work. */
export const REPORT_GRACE_MS = 3_000;
/** How often a link reports its activity at most while its tasks progress; a change of its state is reported at once. */
export const ACTIVITY_COALESCE_MS = 250;
// A link remembers TASK_HISTORY_LIMIT finished tasks, the most an activity names, forgetting the oldest first; those
// still running are never forgotten. What Claude says about a task is kept to TASK_TEXT_MAX characters (a description, a
// phase, a progress line, a summary), TASK_ID_MAX (an id, a subagent type, a tool) and TASK_PATH_MAX (an output file); a
// workflow lists WORKFLOW_PHASES_MAX phases and WORKFLOW_AGENTS_MAX agents at most.
export {
  TASK_HISTORY_LIMIT, TASK_ID_MAX, TASK_PATH_MAX, TASK_TEXT_MAX, WORKFLOW_AGENTS_MAX, WORKFLOW_LABEL_MAX, WORKFLOW_MODEL_MAX, WORKFLOW_PHASES_MAX,
  WORKFLOW_PREVIEW_MAX, WORKFLOW_TITLE_MAX,
};
/**
 * How a task's end is recorded, by the status Claude names; any other is completed. `killed` is a subagent an interrupt or
 * stop_task ended (Claude Code 2.1.304 says it in task_updated; the notice that follows says stopped).
 * @type {Map<string, TaskRecord['status']>}
 */
const TASK_ENDINGS = new Map([['completed', 'completed'], ['stopped', 'stopped'], ['killed', 'stopped'], ['failed', 'failed'], ['error', 'failed']]);
/** The notices that say something about one task, by its id. */
const TASK_NOTICES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);
/** Text Claude sent, cut to `max` characters: a number or a boolean as written, anything else (an object, nothing) null. */
const textOf = (value, max) => (['string', 'number', 'boolean'].includes(typeof value) ? String(value).slice(0, max) : null);

/**
 * The end of a task's output, at most TASK_OUTPUT_MAX bytes of UTF-8 (whole characters): the end of a log is what is
 * looked for. `cut` says whether anything was left out here.
 * @param {string} output @returns {{ text: string, cut: boolean }}
 */
export function outputTail(output) {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= TASK_OUTPUT_MAX) return { text: output, cut: false };
  let start = bytes.length - TASK_OUTPUT_MAX;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1; // not in the middle of a character
  return { text: bytes.subarray(start).toString('utf8'), cut: true };
}

/**
 * MCP servers as the process names them (mcp_status's `mcpServers`, or an init's `mcp_servers`): name, status, where
 * each is configured and why it failed, bounded; the config is left out. Null when the list is not one.
 * @param {unknown} list @returns {{ name: string, status: string, source: string | null, error: string | null }[] | null}
 */
export function mcpServersOf(list) {
  if (!Array.isArray(list)) return null;
  return list.filter((server) => typeof server?.name === 'string' && server.name).slice(0, MCP_SERVERS_MAX).map((server) => ({
    name: server.name.slice(0, 200), status: textOf(server.status, 40) ?? 'pending', source: textOf(server.source, 40), error: textOf(server.error, 500),
  }));
}
/** A count Claude sent, as a whole number from 0 to the largest safe integer; null when it is not a number of zero or more. */
const countOf = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER) : null);
/**
 * A workflow agent's bucket by the state Claude names: Claude Code's schema has `start`, `progress` (at work, making tool
 * calls), `done` and `error`; `error`, and any state it does not name, is failed.
 * @type {Map<unknown, 'running' | 'done'>}
 */
const AGENT_BUCKETS = new Map([['start', 'running'], ['progress', 'running'], ['done', 'done']]);

/**
 * What a workflow's `task_progress` says of its phases and agents (`workflow_progress`), kept as counts: the raw list grows
 * with every agent and repeats on every tick. One entry per `workflow_phase`, in index order, with its index and title, at
 * most WORKFLOW_PHASES_MAX; an agent counts once (by its index, the last entry winning), in its phase's counts and in the
 * totals, or in the totals only when its phase is not listed. An agent that has started or is at work is running, one
 * that is done is done, and one in any other state failed (see AGENT_BUCKETS). `current` is the agent the last progress
 * report named in its description (`<phase>: <label>`); it outlives that agent's work. `agents.list` names the latest
 * WORKFLOW_AGENTS_MAX agents by index (one without an index after them, as listed), each with what its entry says: its
 * label, its phase's index and title (`phaseTitle`, else the title of its phase by index), its state as the counts read
 * it, its model, tokens, tool calls, duration and result preview, each null until Claude reports it. A phase's title and
 * an agent's phase share WORKFLOW_TITLE_MAX; a label, model and preview are cut to their own caps (see the protocol).
 * @param {any[]} entries
 * @param {unknown} description
 * @returns {WorkflowSummary}
 */
function summarizeWorkflow(entries, description) {
  /** @type {Map<number, string>} */
  const titles = new Map();
  /** @type {Map<number | string, { phaseIndex: number | null, bucket: 'running' | 'done' | 'failed', entry: any }>} */
  const agents = new Map();
  entries.forEach((entry, position) => {
    const index = countOf(entry?.index);
    if (entry?.type === 'workflow_phase' && index !== null) titles.set(index, textOf(entry.title, WORKFLOW_TITLE_MAX) ?? '');
    else if (entry?.type === 'workflow_agent') {
      const key = index ?? `#${position}`; // one without an index is told apart by where it is listed
      agents.delete(key); // the last entry wins
      agents.set(key, { phaseIndex: countOf(entry.phaseIndex), bucket: AGENT_BUCKETS.get(entry.state) ?? 'failed', entry });
    }
  });
  const listed = [...titles.keys()].sort((a, b) => a - b).slice(0, WORKFLOW_PHASES_MAX);
  /** @type {Map<number, WorkflowSummary['phases'][number]>} */
  const phases = new Map(listed.map((index) => [index, { index, title: titles.get(index), agents: 0, done: 0, running: 0, failed: 0 }]));
  const totals = { total: 0, running: 0, done: 0, failed: 0 };
  for (const { phaseIndex, bucket } of agents.values()) {
    totals.total += 1;
    totals[bucket] += 1;
    const phase = phaseIndex === null ? undefined : phases.get(phaseIndex);
    if (phase) { phase.agents += 1; phase[bucket] += 1; }
  }
  const byIndex = (/** @type {number | string} */ a, /** @type {number | string} */ b) => (typeof a === 'number' ? (typeof b === 'number' ? a - b : -1) : typeof b === 'number' ? 1 : 0);
  const list = [...agents.keys()].sort(byIndex).slice(-WORKFLOW_AGENTS_MAX).map((key) => {
    const { phaseIndex, bucket, entry } = agents.get(key);
    return {
      label: textOf(entry.label, WORKFLOW_LABEL_MAX) ?? '', phase: textOf(entry.phaseTitle, WORKFLOW_TITLE_MAX) ?? (phaseIndex === null ? null : titles.get(phaseIndex) ?? null),
      phaseIndex, state: bucket, model: textOf(entry.model, WORKFLOW_MODEL_MAX), tokens: countOf(entry.tokens), toolCalls: countOf(entry.toolCalls),
      durationMs: countOf(entry.durationMs), resultPreview: textOf(entry.resultPreview, WORKFLOW_PREVIEW_MAX),
    };
  });
  const current = typeof description === 'string' && description.includes(': ') ? textOf(description, TASK_TEXT_MAX) : null;
  return { phases: [...phases.values()], agents: { ...totals, list }, current };
}

/**
 * A background task of the process (an agent, a workflow, a command), as its notices describe it. `runId` is the task's
 * own run id (Claude Code gives every task one; it is not a workflow's id). `taskType` is Claude's `task_type`
 * (`local_workflow`, `local_bash`, `local_agent`, ...): a workflow is ONE task of type `local_workflow`, named by
 * `workflowName`; its agents have no tasks of their own, and `workflow` is what its progress last said of them (null
 * until a progress carries `workflow_progress`, and for any other task). `parentTaskId` is the task that started it (a
 * subagent's own command names the subagent) and `spawnDepth` how deep a subagent it is; `progress` is its latest progress
 * line (`Running …`, a workflow's `<phase>: <label>`) and `lastTool` the tool it last used, neither ever its description;
 * `summary` and `outputFile` are what its notification said of its end, and `model` the model a background agent answers
 * with, from its own messages. Each is null until Claude says it (a task an earlier process started has no `model`).
 * @typedef {{ taskId: string, runId: string | null, toolUseId: string | null, description: string, subagentType: string | null,
 *   taskType: string | null, workflowName: string | null,
 *   phase: string | null, backgrounded: boolean, status: 'running' | 'completed' | 'stopped' | 'failed', startedAt: string,
 *   endedAt: string | null, usage: { totalTokens: number | null, toolUses: number | null, durationMs: number | null },
 *   workflow: WorkflowSummary | null, parentTaskId: string | null, spawnDepth: number | null, lastTool: string | null,
 *   progress: string | null, summary: string | null, outputFile: string | null, model?: string | null }} TaskRecord
 */
/**
 * A workflow's phases and agents as counts, and its latest agents (see summarizeWorkflow).
 * @typedef {{ label: string, phase: string | null, phaseIndex: number | null, state: 'running' | 'done' | 'failed', model: string | null,
 *   tokens: number | null, toolCalls: number | null, durationMs: number | null, resultPreview: string | null }} WorkflowAgent
 * @typedef {{ phases: { index: number, title: string, agents: number, done: number, running: number, failed: number }[],
 *   agents: { total: number, running: number, done: number, failed: number, list: WorkflowAgent[] }, current: string | null }} WorkflowSummary
 */
/**
 * What the process is doing: answering a run's turn, running background tasks with no turn, or nothing.
 * @typedef {{ state: 'idle' | 'working' | 'background', tasks: TaskRecord[], updatedAt: string }} Activity
 */
/**
 * Why an activity is reported, the strongest change since the last report first: its state changed, a task started or
 * ended (its status changed), or only a task's usage, phase, description or workflow summary did.
 * @typedef {'state' | 'tasks' | 'progress'} ActivityReason
 */

/**
 * Whether a message from a process no run is listening to is the start of a turn it began by itself. Subagents
 * still working in the background report under their parent tool call; those are activity, not a turn.
 */
export const startsTurn = (message) => {
  if (message.type === 'control_request') return true; // a question needs a run to answer it, whoever asks
  if (message.parent_tool_use_id != null) return false;
  if (message.type === 'system') return message.subtype === 'init'; // every turn of the main thread opens with init
  if (message.type === 'assistant' || message.type === 'stream_event' || message.type === 'result') return true;
  if (message.type === 'user') {
    const content = message.message?.content;
    return !(Array.isArray(content) && content.every(block => block?.type === 'tool_result'));
  }
  return false;
};

/** A background subagent's question: the main thread's own permission requests name no agent. */
/** A turn handler's answer for a message that is not its turn's: the turn ends before it, and it goes to a run of its own. */
export const HAND_BACK = 'hand back';
export const isSubagentRequest = (message) => message.type === 'control_request' && message.request?.agent_id != null;
/** What the main thread sends only inside a turn, before or between model calls: compaction, API retries, hooks. */
const TURN_NOTICES = new Set(['status', 'compact_boundary', 'api_retry', 'hook_started', 'hook_progress', 'hook_response']);
export const turnNotice = (message) => message.type === 'system' && TURN_NOTICES.has(message.subtype) && message.parent_tool_use_id == null;
/** Whether the main thread is compacting after `message` (a turn notice), given whether it was before. */
export const compactingAfter = (message, was) => (message.subtype === 'status' ? message.status === 'compacting' : message.subtype === 'compact_boundary' ? false : was);
/** How long the binary says it will wait before retrying the model call. */
export const retryDelay = (message) => (message.subtype === 'api_retry' && Number.isFinite(message.retry_delay_ms) ? message.retry_delay_ms : 0);

/**
 * Remove a process's scratch directory without ever failing the close. Agents leave read-only trees there (a Go
 * module cache, a copied store path), which a plain recursive remove refuses; make them writable and try again.
 */
export function removeScratch(dir, log, context = {}) {
  try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* try again once it is writable */ }
  const writable = (at) => {
    chmodSync(at, 0o700);
    for (const entry of readdirSync(at, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(at, entry.name));
  };
  try { writable(dir); rmSync(dir, { recursive: true, force: true }); }
  catch (error) { log.warn('could not remove the agent scratch directory', { ...context, dir, error: String(error?.message ?? error) }); }
}

/**
 * The links of this engine, one per conversation at most.
 * `lifetime` is told while a process has background work running, which keeps the engine up for it with no client.
 * `onActivity` is told what a process is doing as that changes (see `link.activity`), and why. `history` answers a
 * conversation's stored activity, which a new process starts from (see endedActivity), or null. `requestTimeoutMs` is how
 * long a question to a process (a task's output, the MCP servers' status) waits for its answer.
 * @param {{ spawn?: typeof spawnLineChild, log: any, idleMs?: number, interruptMs?: number, emptyGraceMs?: number, stopGraceMs?: number, requestTimeoutMs?: number, scratchRoot?: string, lifetime?: any,
 *   onUnsolicited?: (link: any) => boolean | Promise<boolean>, onActivity?: (sessionId: string, activity: Activity, reason: ActivityReason) => void,
 *   history?: (sessionId: string) => { state: string, tasks: TaskRecord[], updatedAt: string } | null }} options
 * `onUnsolicited` is told when a process starts a turn by itself and answers true when a run will take it
 */
export function createHostedLinks({ spawn = spawnLineChild, log, idleMs = HOSTED_LINK_IDLE_MS, interruptMs = INTERRUPT_GRACE_MS, emptyGraceMs = EMPTY_RESULT_GRACE_MS, stopGraceMs = STOP_TASK_GRACE_MS, requestTimeoutMs = CONTROL_REQUEST_TIMEOUT_MS, scratchRoot = tmpdir(), onUnsolicited = () => false, lifetime = null, onActivity = () => {}, history = () => null }) {
  /** @type {Map<string, any>} sessionId -> link */
  const links = new Map();
  return {
    get: (sessionId) => links.get(sessionId) ?? null,
    get size() { return links.size; },
    /** Whether any process is answering a turn or has background work running: work the engine must not drop. */
    get working() { return [...links.values()].some((link) => link.working); },
    /**
     * Start the process for a conversation. `prepare` is given the private scratch directory the process will
     * run with and answers its argv and environment.
     * @param {{ sessionId: string, workspaceId: string, agentId: string, identity: string, cwd: string,
     *   prepare: (scratchDir: string) => { argv: string[], env: Record<string, string> }, onClosed?: () => void }} options
     */
    open({ sessionId, workspaceId, agentId, identity, cwd, prepare, onClosed = null }) {
      if (links.get(sessionId)?.alive) throw new Error('this conversation already has an agent process');
      let seed = null;
      try { seed = history(sessionId); } catch (error) { log.warn('could not read the conversation\'s earlier tasks', { sessionId, error: String(error?.message ?? error) }); }
      const link = createLink({
        sessionId, workspaceId, agentId, identity, cwd, prepare, spawn, log, idleMs, interruptMs, emptyGraceMs, stopGraceMs, requestTimeoutMs, scratchRoot, onUnsolicited, seed,
        onBackground: (running) => { if (running) lifetime?.workStarted(); else lifetime?.workFinished(); },
        onActivity: (activity, reason) => onActivity(sessionId, activity, reason),
        // Forgotten the moment the process is gone, before anything waiting on the link is told.
        onEnded: () => { if (links.get(sessionId) === link) links.delete(sessionId); try { onClosed?.(); } catch (error) { log.warn('hosted link cleanup failed', { sessionId, error: String(error) }); } },
      });
      links.set(sessionId, link);
      return link;
    },
    async close(sessionId, reason, { graceful = true } = {}) {
      const link = links.get(sessionId);
      if (link) await link.close({ reason, graceful });
    },
    async closeWorkspace(workspaceId, reason) {
      await Promise.all([...links.values()].filter(link => link.workspaceId === workspaceId).map(link => link.close({ reason, graceful: true })));
    },
    async closeAll(reason = 'engine stopping') {
      await Promise.all([...links.values()].map(link => link.close({ reason, graceful: true })));
    },
    /** Nothing holds the conversation any more: ask again for a run to take a turn its process began by itself. */
    reoffer(sessionId) { links.get(sessionId)?.offer(); },
  };
}

function createLink({ sessionId, workspaceId, agentId, identity, cwd, prepare, spawn, log, idleMs, interruptMs, emptyGraceMs, stopGraceMs, requestTimeoutMs = CONTROL_REQUEST_TIMEOUT_MS, scratchRoot, onUnsolicited, seed = null, onBackground = (/** @type {boolean} */ _running) => {}, onActivity = (/** @type {Activity} */ _activity, /** @type {ActivityReason} */ _reason) => {}, onEnded }) {
  // One private scratch directory per process. Never grant access to all of /tmp.
  const scratchDir = realpathSync(mkdtempSync(path.join(scratchRoot, 'jolo-agent-')));
  const { argv, env } = prepare(scratchDir);
  const controller = new AbortController();
  let gracefulClose = true;
  const child = spawn({ argv, cwd, env, signal: controller.signal, onCancel: () => gracefulClose, log, agentId, maxLineBytes: MAX_LINE_BYTES, maxQueueBytes: MAX_QUEUE_BYTES });
  /**
   * What the process has told us about itself: the model it answers with, the Claude conversation it holds, and its MCP
   * servers as its latest init listed them (see mcpServersOf).
   * @type {{ model: string | null, claudeSessionId: string | null, mcpServers: ReturnType<typeof mcpServersOf> }}
   */
  const state = { model: null, claudeSessionId: null, mcpServers: null };
  /** @type {any} the turn a run is holding */
  let current = null;
  /** @type {any[] | null} a turn the process started by itself, kept until a run takes it */
  let buffer = null;
  /** @type {Promise<void> | null} */
  let closing = null;
  let alive = true;
  let idleTimer = null;
  let sequence = 0;
  // The main thread is in a turn from its init to its result, and has work waiting while a message written to it
  // has not been taken up yet. Each turn's init lists the messages it takes up (`user_message_uuids`), and the binary
  // also echoes most of them and names the message on a result that ends a turn before it started. Otherwise the
  // main thread has nothing to stop.
  let mainTurn = false;
  // An empty result (no model call) may come ahead of the answer in the same turn: until more of the turn follows, or
  // the grace passes with nothing, Stop still interrupts, in case the main thread is about to answer after all.
  // Compaction or a retry after the empty result holds the grace open: the answer comes after it.
  let afterEmpty = false;
  let compacting = false;
  let emptyTimer = null;
  const settleEmpty = () => { afterEmpty = false; compacting = false; if (emptyTimer) { clearTimeout(emptyTimer); emptyTimer = null; } };
  const awaitAnswer = (extraMs = 0) => {
    if (emptyTimer) clearTimeout(emptyTimer);
    afterEmpty = true;
    emptyTimer = setTimeout(() => (compacting ? awaitAnswer() : settleEmpty()), emptyGraceMs + extraMs);
    emptyTimer.unref?.();
  };
  /** @type {Set<string>} the ids of messages written but not yet taken up */
  const queued = new Set();
  const mainIdle = () => !mainTurn && queued.size === 0;
  /** The Stops sent, by request id: a receipt lists the messages each one dropped. */
  const stops = new Set();
  /**
   * Stop ends the turn under way and what waits behind it. Background work is spared (Jolo declares perTaskStopAffordance
   * at initialize): it is listed, and stopped on its own with `stopBackground` or `stopTask`.
   */
  const sendStop = () => {
    const requestId = `jolo-interrupt-${++sequence}`;
    stops.add(requestId);
    write({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt', cancel_queued: true } });
  };
  /** The Stop was handled: nothing the stopped run wrote is left to run, so once the main thread is idle it is over
   * (after an empty result its answer may still be on the way; the interrupted result, or the time limit, ends it). */
  const stopped = (response) => {
    for (const uuid of response.response?.cancelled ?? []) queued.delete(uuid);
    for (const uuid of current?.withdrawing ?? []) queued.delete(uuid);
    if (current?.signal.aborted && mainIdle() && !afterEmpty) finishTurn(current, { exited: false });
  };
  /** @type {Map<string, (answer: { ok: boolean, error: string | null }) => void>} the stop_task requests still unanswered, by request id, with who waits on Claude's answer */
  const taskStops = new Map();
  /** @param {string} taskId */
  const stopTask = (taskId) => new Promise((resolve) => {
    if (!alive) { resolve({ ok: false, error: 'process ended' }); return; }
    const requestId = `jolo-stop-task-${++sequence}`;
    // An answer that has not come within the grace is given up on; one that comes later is ignored.
    const timer = setTimeout(() => answered({ ok: false, error: 'no answer' }), stopGraceMs);
    const answered = (answer) => { clearTimeout(timer); taskStops.delete(requestId); resolve(answer); };
    taskStops.set(requestId, answered);
    write({ type: 'control_request', request_id: requestId, request: { subtype: 'stop_task', task_id: taskId } });
  });
  /** @type {Map<string, (response: any) => void>} the host's own questions to the process still unanswered, by request id */
  const questions = new Map();
  /**
   * Ask the process something with a control request and wait for its answer (requestTimeoutMs). Resolves the answer's
   * `response`; rejects on an `error` answer (with Claude's words), on the time running out (`timedOut`), and when the
   * process has ended or ends meanwhile (code `no_process`).
   * @param {string} subtype @param {Record<string, unknown>} [fields] @returns {Promise<any>}
   */
  const question = (subtype, fields = {}) => new Promise((resolve, reject) => {
    if (!alive || closing) { reject(Object.assign(new Error('the process has ended'), { code: 'no_process' })); return; }
    const requestId = `jolo-${subtype}-${++sequence}`;
    const timer = setTimeout(() => { questions.delete(requestId); reject(Object.assign(new Error(`${subtype} had no answer`), { timedOut: true })); }, requestTimeoutMs);
    questions.set(requestId, (response) => {
      clearTimeout(timer);
      questions.delete(requestId);
      if (response.subtype === 'success') resolve(response.response ?? {});
      else if (response.subtype === 'ended') reject(Object.assign(new Error('the process has ended'), { code: 'no_process' }));
      else reject(new Error(String(response.error ?? `${subtype} failed`)));
    });
    write({ type: 'control_request', request_id: requestId, request: { subtype, ...fields } });
  });
  /** Claude answered a stop_task: the task is on its way out, or Claude says why it is not. */
  const taskStopAnswered = (response) => {
    taskStops.get(response.request_id)(response.subtype === 'success' ? { ok: true, error: null } : { ok: false, error: String(response.error ?? 'stop_task failed') });
  };
  // Where each subagent runs, from what every message says whoever holds the conversation: a subagent's messages and
  // its task_started name the Agent/Task call it runs under, and a subagent's own Agent/Task call names the call above.
  const agentCalls = new Map();
  const callParents = new Map();
  const traceAgents = (message) => {
    if (message.type === 'system' && message.subtype === 'task_started' && message.task_id && message.tool_use_id) { agentCalls.set(message.task_id, message.tool_use_id); return; }
    if (message.parent_tool_use_id == null || !message.agent_id) return;
    agentCalls.set(message.agent_id, message.parent_tool_use_id);
    if (message.type === 'assistant') for (const block of message.message?.content ?? []) if (block?.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name)) callParents.set(block.id, message.parent_tool_use_id);
  };
  // Background tasks the process runs and has run (agents, workflows, commands), from the notices it sends as they
  // start, progress and end: while any runs, the process has work the engine must keep alive even with no turn and no
  // client. The finished ones are kept as its recent history.
  /** @type {Map<string, TaskRecord>} taskId -> its record, in the order they started */
  const tasks = new Map();
  /** @type {Map<string, string>} the call a task runs under -> the task, for the tasks this process started */
  const taskOfCall = new Map();
  /** Forget a task, and the call it ran under. @param {string} taskId */
  const dropTask = (taskId) => {
    const call = tasks.get(taskId)?.toolUseId;
    if (call && taskOfCall.get(call) === taskId) taskOfCall.delete(call);
    tasks.delete(taskId);
  };
  const running = () => { let count = 0; for (const task of tasks.values()) if (task.status === 'running') count += 1; return count; };
  /** Told whenever a running task ends, with the process's end too: what stopping background work waits on. */
  const endWatchers = new Set();
  const tasksEnded = () => { for (const watcher of [...endWatchers]) watcher(); };
  // What the process is doing, told to `onActivity` at most every ACTIVITY_COALESCE_MS while its tasks change, and at
  // once whenever its state does, with the strongest reason seen since the last report.
  let activityAt = new Date().toISOString();
  let reportedState = 'idle';
  /** @type {'tasks' | 'progress' | null} how its tasks changed since the last report */
  let tasksChange = null;
  let activityTimer = null;
  const activityState = () => (current ? 'working' : running() ? 'background' : 'idle');
  /** @returns {Activity} */
  const snapshotActivity = () => ({ state: activityState(), tasks: [...tasks.values()].map((task) => ({ ...task, usage: { ...task.usage } })), updatedAt: activityAt });
  const reportActivity = () => {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    const activity = snapshotActivity();
    /** @type {ActivityReason} */
    const reason = activity.state !== reportedState ? 'state' : tasksChange ?? 'progress';
    reportedState = activity.state;
    tasksChange = null;
    try { onActivity(activity, reason); } catch (error) { log.warn('could not report what the agent process is doing', { sessionId, agentId, error: String(error?.message ?? error) }); }
  };
  /**
   * Its tasks changed (`change`: 'tasks' when one started or ended, 'progress' when only its usage, phase,
   * description or workflow summary did), or a turn began or ended: report it, at once when its state is a new one.
   * @param {'tasks' | 'progress' | null} [change]
   */
  const activityChanged = (change = null) => {
    const stateChanged = activityState() !== reportedState;
    if (!change && !stateChanged) return;
    if (change && tasksChange !== 'tasks') tasksChange = change;
    activityAt = new Date().toISOString();
    if (stateChanged) reportActivity();
    else if (!activityTimer) { activityTimer = setTimeout(reportActivity, ACTIVITY_COALESCE_MS); activityTimer.unref?.(); }
  };
  // Background work that has just finished is reported in a turn the process begins a moment later: until that turn
  // begins, the work is not over, and a stop or a reload must not cut the report off.
  let reportDue = null;
  const settleReport = () => { if (reportDue) { clearTimeout(reportDue); reportDue = null; } };
  // Every field is read through textOf/countOf: what Claude sends is bounded and typed before it is kept or published.
  // A task is background work unless Claude says it is not: it sets is_backgrounded only for agents and commands, so a
  // workflow or an MCP call it moved off the turn arrives without one (its own client reads the flag the same way).
  /** @param {string} taskId @param {any} message @param {string} at @returns {TaskRecord} */
  const newTask = (taskId, message, at) => ({
    taskId, runId: textOf(message.run_id, TASK_ID_MAX), toolUseId: textOf(message.tool_use_id, TASK_ID_MAX), description: textOf(message.description, TASK_TEXT_MAX) ?? '',
    subagentType: textOf(message.subagent_type, TASK_ID_MAX), taskType: textOf(message.task_type, TASK_ID_MAX), workflowName: textOf(message.workflow_name, TASK_TEXT_MAX),
    phase: null, backgrounded: message.is_backgrounded !== false, status: 'running',
    startedAt: at, endedAt: null, usage: { totalTokens: null, toolUses: null, durationMs: null }, workflow: null,
    parentTaskId: textOf(message.parent_task_id, TASK_ID_MAX), spawnDepth: countOf(message.spawn_depth),
    lastTool: null, progress: null, summary: null, outputFile: null, model: null,
  });
  /** A count that is not one leaves what was known. @param {TaskRecord} task @param {any} usage */
  const takeUsage = (task, usage) => {
    task.usage.totalTokens = countOf(usage?.total_tokens) ?? task.usage.totalTokens;
    task.usage.toolUses = countOf(usage?.tool_uses) ?? task.usage.toolUses;
    task.usage.durationMs = countOf(usage?.duration_ms) ?? task.usage.durationMs;
  };
  /** Whether a notice naming no usable task was logged already: one is enough to tell. */
  let namelessLogged = false;
  /** @param {TaskRecord} task @param {TaskRecord['status']} status @param {string} at */
  const finish = (task, status, at) => {
    const was = task.status;
    task.status = status;
    task.endedAt ??= at;
    if (was !== 'running') return;
    // Claude reports a task that ends while no turn runs in a turn of its own, whatever its flag; one that ends inside a
    // foreground turn is reported there.
    if (task.backgrounded || current === null) {
      settleReport();
      reportDue = setTimeout(() => { reportDue = null; }, REPORT_GRACE_MS);
      reportDue.unref?.();
    }
    if (!running()) onBackground(false);
    tasksEnded();
  };
  /** Forget the oldest finished tasks past the history limit. */
  const trimTasks = () => {
    let excess = tasks.size - running() - TASK_HISTORY_LIMIT;
    for (const [taskId, task] of tasks) {
      if (excess <= 0) break;
      if (task.status !== 'running') { dropTask(taskId); excess -= 1; }
    }
  };
  // The conversation's earlier tasks, as its stored activity last had them: the history the panel shows outlives the
  // process. Each keeps its id, so a later notice about one (Claude re-reports a previous process's command on resume)
  // updates it in place. One the earlier process left running ended with it; that is reported, so it is stored so.
  if (Array.isArray(seed?.tasks)) {
    const settled = endedActivity(seed).tasks;
    for (const task of settled) if (typeof task?.taskId === 'string') tasks.set(task.taskId, task);
    trimTasks();
    if (seed.tasks.some((task) => task?.status === 'running')) activityChanged('tasks');
  }
  const trackTasks = (message) => {
    if (message.type !== 'system' || !TASK_NOTICES.has(message.subtype)) return;
    const taskId = textOf(message.task_id, TASK_ID_MAX);
    if (!taskId) {
      if (!namelessLogged) log.warn('ignored task notices from the agent process that name no task', { sessionId, agentId, subtype: message.subtype });
      namelessLogged = true;
      return;
    }
    const at = new Date().toISOString();
    let task = tasks.get(taskId);
    const was = task?.status ?? null;
    if (message.subtype === 'task_started') {
      if (!running()) onBackground(true);
      dropTask(taskId); // one started again is listed anew, as the newest
      const started = newTask(taskId, message, at);
      tasks.set(taskId, started);
      if (started.toolUseId) taskOfCall.set(started.toolUseId, taskId);
    } else if (message.subtype === 'task_progress' && task) {
      takeUsage(task, message.usage);
      // The description stays the one the task started with: what a progress report says there is what the task does now
      // (`Running …`, a workflow's current agent), kept as its progress line; one that says none leaves the last.
      task.progress = textOf(message.description, TASK_TEXT_MAX) ?? task.progress;
      task.lastTool = textOf(message.last_tool_name, TASK_ID_MAX) ?? task.lastTool;
      // A new summary each time, never changed in place: a snapshot already reported shares it.
      if (Array.isArray(message.workflow_progress)) task.workflow = summarizeWorkflow(message.workflow_progress, message.description);
    } else if (message.subtype === 'task_updated' && task) {
      const patch = message.patch ?? {};
      if (typeof patch.is_backgrounded === 'boolean') task.backgrounded = patch.is_backgrounded; // moved to the background later
      task.phase = textOf(patch.workflow_phase ?? patch.phase, TASK_TEXT_MAX) ?? task.phase;
      task.description = textOf(patch.description, TASK_TEXT_MAX) ?? task.description;
      const ending = TASK_ENDINGS.get(patch.status);
      if (ending) finish(task, ending, at);
    } else if (message.subtype === 'task_notification') {
      const ending = TASK_ENDINGS.get(message.status) ?? 'completed';
      if (task) finish(task, ending, at);
      else { // one never seen to start is recorded all the same; it never kept the process
        task = { ...newTask(taskId, message, at), status: ending, endedAt: at };
        tasks.set(taskId, task);
      }
      takeUsage(task, message.usage);
      // How it ended, as its notice says: Claude Code sends an empty output file for a task that wrote none.
      task.summary = textOf(message.summary, TASK_TEXT_MAX) ?? task.summary;
      task.outputFile = textOf(message.output_file, TASK_PATH_MAX) || task.outputFile;
    } else return;
    trimTasks();
    // A task listed anew, or one whose status changed, is a change of its tasks; anything else is their progress.
    activityChanged(message.subtype === 'task_started' || task.status !== was ? 'tasks' : 'progress');
  };
  /**
   * A background agent's model: Claude names it only on the agent's own messages (`agent_id` and the call it runs under,
   * `parent_tool_use_id`, on the envelope), so the agent task started for that call takes it; a command or other task
   * has none. A model in angle brackets is none either: Claude Code's own synthetic messages say `<synthetic>`. It is
   * progress, not a change of the tasks: it goes out with the next report.
   */
  const trackModel = (message) => {
    if (message.type !== 'assistant' || !message.agent_id || message.parent_tool_use_id == null || typeof message.message?.model !== 'string') return;
    if (message.message.model.startsWith('<')) return;
    const taskId = taskOfCall.get(message.parent_tool_use_id);
    const task = taskId ? tasks.get(taskId) : undefined;
    if (!task || !(task.taskType === 'local_agent' || task.subagentType)) return;
    const model = textOf(message.message.model, WORKFLOW_MODEL_MAX);
    if (!model || task.model === model) return;
    task.model = model;
    activityChanged('progress');
  };
  const follow = (message) => {
    trackTasks(message);
    traceAgents(message);
    trackModel(message);
    if (message.parent_tool_use_id != null) return;
    if (message.type === 'system' && message.subtype === 'init') {
      state.mcpServers = mcpServersOf(message.mcp_servers) ?? state.mcpServers;
      settleEmpty();
      settleReport(); // the report has begun: a run holds it, or it waits for one
      mainTurn = true;
      for (const id of message.user_message_uuids ?? []) queued.delete(id);
    } else if (message.type === 'result') {
      mainTurn = false;
      if (message.user_message_uuid) queued.delete(message.user_message_uuid);
      settleEmpty();
      if ((message.num_turns ?? 0) === 0 && !message.is_error) awaitAnswer();
    } else if (message.type === 'user' && message.isReplay) {
      if (message.uuid) queued.delete(message.uuid);
    } else if (afterEmpty && turnNotice(message)) {
      compacting = compactingAfter(message, compacting);
      awaitAnswer(retryDelay(message)); // compacting or retrying before the answer: the grace starts over
    } else if (message.type === 'control_response' && questions.has(message.response?.request_id)) {
      questions.get(message.response.request_id)(message.response);
    } else if (message.type === 'control_response' && taskStops.has(message.response?.request_id)) {
      taskStopAnswered(message.response);
    } else if (message.type === 'control_response' && stops.delete(message.response?.request_id)) {
      stopped(message.response);
    } else if (['assistant', 'stream_event', 'user'].includes(message.type)) {
      // A question is not work begun: the main thread only asks inside a turn it opened with init, so one asked while
      // it is idle comes from background work (a subagent, the sandbox's network check, an MCP server).
      settleEmpty();
      mainTurn = true;
    }
  };

  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  /** The process said or was told something: it is not idle. */
  const touch = () => {
    clearIdle();
    if (!alive || current || closing) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Background work still running keeps it, however quiet; a turn no run could be started for does not.
      if (alive && !current && (!buffer || offerFailed) && !running()) void close({ reason: 'idle', graceful: true });
    }, idleMs);
    idleTimer.unref?.();
  };

  const finishTurn = (turn, outcome) => {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    if (current === turn) current = null;
    activityChanged();
    turn.resolve(outcome);
    settleEmpty(); // an answer that comes now has no run waiting for it
    touch();
  };

  /**
   * Hand one message to the turn in progress; a handler that answers true has seen the turn's end, and one that answers
   * HAND_BACK has seen a message beyond it, which is then handled as if no turn were in progress.
   */
  const deliver = async (turn, message, replayed = false) => {
    let answer;
    try { answer = await turn.handle(message, { replayed }); }
    catch (error) {
      // A run being stopped refuses further work (a tool starting after Stop throws); its interrupt ends the turn.
      if (turn.signal.aborted) return;
      // A host-side failure mid-turn leaves the process in a state nobody is tracking; close it rather than guess.
      finishTurn(turn, { exited: false, failure: error });
      void close({ reason: 'turn handler failed', graceful: false });
      return;
    }
    if (answer === true || answer === HAND_BACK) finishTurn(turn, { exited: false });
    if (answer === HAND_BACK) await dispatch(message);
  };

  /** Main-thread tool calls in the waiting turn: a foreground subagent's own messages report under them. */
  const bufferedCalls = new Set();
  const keep = (message) => {
    // Partial output only previews the full messages that follow, which are what a run taking the turn later shows;
    // keeping every partial would let one long answer fill the buffer. Each model call's start and end are kept.
    if (message.type === 'stream_event' && !['message_start', 'message_delta', 'message_stop'].includes(message.event?.type)) return;
    if (message.type === 'assistant' && message.parent_tool_use_id == null) for (const block of message.message?.content ?? []) if (block?.type === 'tool_use') bufferedCalls.add(block.id);
    if (buffer.length >= BUFFER_LIMIT) {
      log.warn('hosted agent kept talking with nobody listening; closing its process', { sessionId, agentId });
      void close({ reason: 'unattended output overflow', graceful: false });
      return;
    }
    buffer.push(message);
  };

  /** Whether the last ask found the conversation busy; only such a turn is offered again when it is free. */
  let declined = false;
  /** Whether the last ask could not start a run at all (the workspace is gone, say): nothing will take the turn. */
  let offerFailed = false;
  /** Ask for a run to take what the process said while nobody was listening. */
  const ask = async () => {
    if (closing || !alive) { declined = false; return; } // a process going away starts no run
    let taken = false;
    offerFailed = false;
    try { taken = (await onUnsolicited(link)) === true; }
    catch (error) { offerFailed = true; log.warn('could not start a run for a turn the agent began by itself', { sessionId, agentId, error: String(error?.message ?? error) }); }
    declined = !taken;
    if (!taken) log.info('the agent began a turn by itself; it waits for the next run', { sessionId, agentId });
  };

  /**
   * The process began a turn by itself: keep what it says, from the message that starts the turn, and ask for a run to
   * take it. Notices with no turn behind them (what a background task reports while it works) are not kept on their own.
   */
  const unsolicited = async (messages) => {
    if (closing) return;
    const start = messages.findIndex(startsTurn);
    if (start < 0) return;
    buffer = [];
    bufferedCalls.clear();
    for (const message of messages.slice(start)) keep(message);
    if (!buffer.length) { buffer = null; return; } // a partial alone: the turn's next message starts it
    await ask();
  };

  /** The process took back a question nobody has answered yet: forget it, and the waiting turn if that was all it was. */
  const withdraw = (requestId) => {
    const rest = buffer.filter((m) => !(m.type === 'control_request' && m.request_id === requestId));
    const start = rest.findIndex(startsTurn);
    buffer = start < 0 ? null : rest.slice(start);
  };

  const dispatch = async (message) => {
    // A run stopped while the main thread was idle sent an interrupt nothing will answer: a turn beginning now is new
    // work (a background task reporting back), not the stopped run's, and goes to a run of its own.
    if (current?.idleInterrupt && message.type === 'system' && message.subtype === 'init') finishTurn(current, { exited: false });
    if (current) { await current.ready; if (current) return deliver(current, message); }
    // A subagent still working in the background is activity a run would skip anyway; keeping it would only fill the buffer.
    if (buffer && message.type === 'control_cancel_request') return withdraw(message.request_id);
    if (buffer && message.parent_tool_use_id != null && message.type !== 'control_request') {
      // A subagent working in the background is activity a run would skip; one working for a call in the waiting turn
      // is that turn's progress.
      return message.type === 'assistant' && bufferedCalls.has(message.parent_tool_use_id) ? keep(message) : undefined;
    }
    if (buffer) return keep(message);
    if (startsTurn(message)) return unsolicited([message]);
    // keep_alive, system notices, background subagents: activity, nothing to deliver
  };

  const closed = (async () => {
    let settled = { exitCode: null, stderr: '' };
    try {
      for await (const message of child.messages()) {
        touch();
        follow(message);
        await dispatch(message);
      }
    } catch (error) {
      log.warn('hosted agent process failed', { sessionId, agentId, error: String(error?.message ?? error) });
    } finally {
      alive = false;
      clearIdle();
      settleEmpty();
      if (running()) { // what still ran ends with the process
        const at = new Date().toISOString();
        for (const task of tasks.values()) if (task.status === 'running') { task.status = 'failed'; task.endedAt = at; }
        onBackground(false);
        activityChanged('tasks');
      }
      // A change still waiting out the coalescing is reported now, before anything awaits: once the link is forgotten a
      // new process may start from the stored record, which a late report would then overwrite with this one's.
      if (activityTimer) reportActivity();
      for (const answered of [...taskStops.values()]) answered({ ok: false, error: 'process ended' }); // no answer comes now
      for (const answered of [...questions.values()]) answered({ subtype: 'ended' });
      tasksEnded();
      settleReport();
      try { settled = await child.settle(); } catch { /* the reader already reported */ }
      removeScratch(scratchDir, log, { sessionId, agentId });
      onEnded();
      const turn = current;
      current = null;
      if (turn) finishTurn(turn, { exited: true, ...settled });
      if (buffer?.length) log.info('a turn the agent began by itself was lost with its process', { sessionId, agentId, messages: buffer.length });
      buffer = null;
      log.info('hosted agent process ended', { sessionId, agentId, exitCode: settled.exitCode });
    }
    return settled;
  })();

  const write = (message) => {
    if (!alive) return;
    if (message.type === 'user' && message.uuid) queued.add(message.uuid);
    child.write(message);
  };

  const interrupt = (turn) => {
    if (turn.finished || !alive) return;
    // Stop ends the turn and the message waiting behind it; the background work the process runs goes on (see sendStop).
    turn.withdrawing = new Set(queued);
    sendStop();
    // Only a subagent's question was open: no turn of the main thread to wait for.
    if (mainIdle() && !afterEmpty) { finishTurn(turn, { exited: false }); return; }
    turn.idleInterrupt = mainIdle(); // only an empty result's grace asks for it: the answer may still be on its way
    turn.interruptTimer = setTimeout(() => {
      if (turn.finished) return;
      if (mainIdle()) finishTurn(turn, { exited: false }); // the turn ended without a result: nothing left to kill
      else void close({ reason: 'interrupt timed out', graceful: false });
    }, interruptMs);
  };

  /**
   * Stop every running task with stop_task, and give them the grace (STOP_TASK_GRACE_MS) to end. Only a Claude Code that
   * cannot stop tasks (it answers `not supported`; its interrupt still ends background work) is sent one Stop instead, at
   * once. A task still running after the grace, or one Claude will not stop for another reason (it does not know it: it
   * has just ended), is reported not stopped and left running: a Stop would spare it anyway, and end the person's turn.
   * `stopped` is how many of the tasks ended in that time.
   * @returns {Promise<{ requested: number, stopped: number, escalated: boolean }>}
   */
  const stopBackground = () => {
    const ids = [...tasks.values()].filter((task) => task.status === 'running').map((task) => task.taskId);
    if (!alive || !ids.length) return Promise.resolve({ requested: 0, stopped: 0, escalated: false });
    const refused = new Set();
    const runs = (taskId) => tasks.get(taskId)?.status === 'running';
    const waitedOn = () => ids.filter((taskId) => !refused.has(taskId) && runs(taskId));
    return new Promise((resolve) => {
      let graceTimer = null;
      const end = (escalate) => {
        if (!endWatchers.delete(check)) return; // already over
        clearTimeout(graceTimer);
        const escalated = escalate && alive && waitedOn().length > 0;
        if (escalated) sendStop();
        resolve({ requested: ids.length, stopped: ids.filter((taskId) => !refused.has(taskId) && !runs(taskId)).length, escalated });
      };
      const check = () => { if (!waitedOn().length) end(false); };
      endWatchers.add(check);
      graceTimer = setTimeout(() => end(false), stopGraceMs);
      for (const taskId of ids) void stopTask(taskId).then(({ ok, error }) => {
        if (ok) return; // its notice ends it
        if (error?.includes('not supported')) end(true); // this Claude Code cannot stop tasks: only a Stop ends them
        else { refused.add(taskId); check(); }
      });
    });
  };

  const close = ({ reason = 'closed', graceful = true } = {}) => {
    if (closing) return closing;
    closing = (async () => {
      clearIdle();
      if (alive) {
        log.info('closing hosted agent process', { sessionId, agentId, reason, graceful });
        if (graceful) {
          if (running()) await stopBackground(); // its tasks are stopped first, within the grace; any still running end with the process
          if (alive) { child.end(); child.terminate({ graceful: true }); } // EOF first: the process leaves by itself; signals follow if it does not
        } else { gracefulClose = false; controller.abort(); }
      }
      await closed;
    })();
    return closing;
  };

  const link = {
    sessionId, workspaceId, agentId, identity, scratchDir, state, closed,
    get alive() { return alive && !closing; },
    get busy() { return current !== null; },
    /** Whether the process has begun a turn by itself that no run has taken yet. */
    get pending() { return buffer !== null; },
    /** Whether a turn is under way, waits for a run, or background work runs or is about to report: work not to be dropped. */
    get working() { return alive && (current !== null || buffer !== null || running() > 0 || reportDue !== null); },
    /** What the process is doing, with the tasks it runs and its recently finished ones; told to `onActivity` as it changes. */
    get activity() { return snapshotActivity(); },
    /**
     * Forget the finished tasks (Clear finished): how many went; the running ones stay. The change is reported at once,
     * not coalesced, so that it is stored before the process could end and a new one start from the old record.
     */
    clearFinished() {
      let cleared = 0;
      for (const [taskId, task] of tasks) if (task.status !== 'running') { dropTask(taskId); cleared += 1; }
      if (cleared) { activityAt = new Date().toISOString(); tasksChange = 'tasks'; reportActivity(); }
      return cleared;
    },
    /** Whether what waits for a run is only a background subagent's question, with the main thread idle. */
    get pendingQuestionOnly() {
      return buffer !== null && buffer.length > 0 && buffer[0].type === 'control_request' && mainIdle()
        && !buffer.some((message) => message.type !== 'control_request' && startsTurn(message)); // no turn of the main thread waits behind it
    },
    /** Whether a message this side wrote waits in the binary's queue, not yet taken up and not dropped. */
    queues: (uuid) => queued.has(uuid),
    /** The main thread's call a subagent runs under, through any subagents above it; undefined when it is not known. */
    callOf(agentId) {
      let call = agentCalls.get(agentId);
      for (let hops = 0; call !== undefined && callParents.has(call) && hops < 16; hops++) call = callParents.get(call);
      return call;
    },
    write,
    /** Ask again for a run to take a waiting turn, when nothing holds the conversation any more. */
    offer() { if (buffer && declined && !current && alive && !closing) void ask(); },
    /**
     * Take the process for one turn. Anything it said while nobody was listening is delivered first. The
     * handler sees every message and answers true when the turn is over; the turn also ends when the run is
     * cancelled (the process is asked to stop) or the process exits.
     * `handle` is told when a message is one the process sent before the turn was taken (`replayed`).
     * @param {{ signal: AbortSignal, handle: (message: any, meta?: { replayed: boolean }) => Promise<boolean | string | void> | boolean | string | void }} options
     * @returns {{ done: Promise<{ exited: boolean, exitCode?: number | null, stderr?: string, failure?: any }>, end: () => void }}
     */
    beginTurn({ signal, handle }) {
      if (!alive || closing) throw new Error('the agent process for this conversation has ended');
      if (current) throw new Error('this conversation is already in a turn');
      let resolve;
      const turn = { handle, signal, finished: false, resolve: null, interruptTimer: null, ready: null };
      turn.resolve = (outcome) => resolve(outcome);
      const done = new Promise((r) => { resolve = r; });
      current = turn;
      activityChanged();
      clearIdle();
      const replay = buffer ?? [];
      buffer = null;
      bufferedCalls.clear();
      turn.ready = (async () => {
        for (const [index, message] of replay.entries()) {
          if (turn.finished) {
            // What follows belongs to a later turn the process began on its own; keep it for the next run.
            const rest = replay.slice(index);
            if (rest.length) void unsolicited(rest);
            return;
          }
          await deliver(turn, message, true);
        }
      })();
      const onAbort = () => interrupt(turn);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      done.finally(() => signal.removeEventListener('abort', onAbort));
      return { done, end: () => finishTurn(turn, { exited: false }) };
    },
    /**
     * Ask the process to stop one background task (an agent, a workflow, a command); its end arrives as a task notice.
     * `error` is Claude's reason when it will not, 'no answer' when none came within the grace, or 'process ended'.
     * @returns {Promise<{ ok: boolean, error: string | null }>}
     */
    stopTask,
    stopBackground,
    /**
     * A task's whole output as the process holds it (while the task runs and after it ended): its last TASK_OUTPUT_MAX
     * bytes, `truncated` when earlier output was left out by the process or here. Rejects with Claude's words for a task
     * it does not know, `timedOut` with no answer, and code `no_process` once the process has ended.
     * @param {string} taskId @returns {Promise<{ output: string, totalBytes: number, truncated: boolean }>}
     */
    async taskOutput(taskId) {
      const answer = await question('get_task_output', { task_id: taskId });
      const { text, cut } = outputTail(typeof answer.output === 'string' ? answer.output : '');
      return { output: text, totalBytes: countOf(answer.total_bytes) ?? Buffer.byteLength(text), truncated: cut || answer.truncated === true };
    },
    /** The process's MCP servers and how each is, as it says now (see mcpServersOf). @returns {Promise<{ servers: ReturnType<typeof mcpServersOf> }>} */
    async mcpStatus() {
      const answer = await question('mcp_status');
      return { servers: mcpServersOf(answer.mcpServers) ?? [] };
    },
    close,
  };
  touch();
  return link;
}
