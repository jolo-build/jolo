import { expect, test } from 'bun:test';
import { LARGE_RUN_AGENTS, activityLine, backgroundTasks, forceStopOffered, formatElapsed, formatTokens, groupActivity, newerActivity, plural, runningTasks, stopFor, taskKind, workflowPhaseStatus, workflowSummary } from '../src/renderer/activity.js';

const START = Date.parse('2026-10-24T10:00:00.000Z');
const at = (seconds) => new Date(START + seconds * 1000).toISOString();
let ids = 0;
/** @typedef {import('../src/renderer/activity.js').TaskRecord} TaskRecord */
/** @param {Record<string, any>} [options] @returns {TaskRecord} */
const task = ({ runId = null, phase = null, status = 'running', started = 0, ended = null, tokens = null, toolUseId = null, description = 'A task', backgrounded = true, taskType = null, workflowName = null, subagentType = null, workflow = undefined } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId, description, subagentType, taskType, workflowName, phase, backgrounded, status,
  startedAt: at(started), endedAt: ended === null ? null : at(ended), usage: { totalTokens: tokens, toolUses: null, durationMs: null }, workflow,
});
/** A workflow as Claude Code 2.1.304 reports one: one task of type local_workflow, named. @param {Record<string, any>} [options] */
const workflow = (options = {}) => task({ taskType: 'local_workflow', workflowName: 'demo', description: 'Workflow demo', ...options });
/** A phase of a workflow's summary, as the engine keeps it from Claude's progress report. @param {string} title @param {Record<string, number>} [counts] */
const phase = (title, { agents = 0, done = 0, running = 0, failed = 0 } = {}) => ({ title, agents, done, running, failed });
/**
 * A workflow's summary: its phases, the totals over its agents (by default those of the phases), the current agent.
 * @param {ReturnType<typeof phase>[]} phases @param {{ total: number, running: number, done: number, failed: number } | null} [agents] @param {string | null} [current]
 */
const progress = (phases, agents = null, current = null) => ({
  phases, current,
  agents: agents ?? phases.reduce((sum, item) => ({ total: sum.total + item.agents, running: sum.running + item.running, done: sum.done + item.done, failed: sum.failed + item.failed }), { total: 0, running: 0, done: 0, failed: 0 }),
});
/** @param {TaskRecord[]} tasks @param {import('../src/renderer/activity.js').Activity['state']} [state] @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks, state = 'background') => ({ state, tasks, truncated: false, updatedAt: at(0) });

test('runningTasks keeps the running ones, foreground ones too, and reads nothing from no activity', () => {
  const running = task();
  const foreground = task({ backgrounded: false });
  expect(runningTasks(activity([running, foreground, task({ status: 'completed', ended: 5 })]))).toEqual([running, foreground]);
  expect(runningTasks(null)).toEqual([]);
});

test('a workflow is one task of type local_workflow; the rest are tasks, whatever run ids they carry, running first and newest first', () => {
  const oldDone = task({ status: 'completed', started: 1, ended: 2, runId: 'r1' });
  const newDone = task({ status: 'completed', started: 5, ended: 6, runId: 'r2' });
  const oldRunning = task({ started: 2, runId: 'r3' });
  const newRunning = task({ started: 4, runId: 'r4' });
  const doneFlow = workflow({ status: 'completed', started: 0, ended: 9 });
  const oldFlow = workflow({ started: 1 });
  const newFlow = workflow({ started: 3 });
  const { workflows, tasks } = groupActivity(activity([doneFlow, oldDone, oldFlow, oldRunning, newRunning, newFlow, newDone]));
  expect(workflows).toEqual([newFlow, oldFlow, doneFlow]);
  expect(tasks).toEqual([newRunning, oldRunning, newDone, oldDone]);
});

test('groupActivity of no activity is empty', () => {
  expect(groupActivity(null)).toEqual({ workflows: [], tasks: [] });
});

test('Review Focus 3: two hundred tasks, sixteen of them workflows, group in one pass', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => index < 16 ? workflow({ started: index }) : task({ runId: `run-${index}`, started: index, tokens: 1000 }));
  const grouped = groupActivity(activity(tasks));
  expect(grouped.workflows).toHaveLength(16);
  expect(grouped.tasks).toHaveLength(184);
});

test("a task's kind comes from Claude's task type: a workflow, a command, an agent, else a task", () => {
  expect(taskKind(workflow())).toBe('Workflow');
  expect(taskKind(task({ taskType: 'local_bash' }))).toBe('Command');
  expect(taskKind(task({ taskType: 'local_agent' }))).toBe('Agent');
  expect(taskKind(task({ subagentType: 'general-purpose' }))).toBe('Agent'); // an engine from before task types
  expect(taskKind(task({ taskType: 'remote_agent' }))).toBe('Task');
  expect(taskKind(task())).toBe('Task');
});

test('a background command as the real binary reports it, with a run id of its own, is a Command row, not a workflow', () => {
  const sleep = task({ runId: '0mvll0x40-1842e72b', taskType: 'local_bash', backgrounded: true, description: 'Sleep for 60 seconds', started: 0 });
  const grouped = groupActivity(activity([sleep]));
  expect(grouped).toEqual({ workflows: [], tasks: [sleep] });
  expect(taskKind(sleep)).toBe('Command');
  expect(activityLine(activity([sleep]), { now: START + 30_000 })).toEqual({ text: 'Background work: 1 task · 00:30', running: 1 });
});

test('the activity line counts background tasks and their elapsed time, without tokens nobody reported', () => {
  const tasks = [task({ started: 0 }), task({ started: 10 })];
  expect(activityLine(activity(tasks), { now: START + 30_000 })).toEqual({ text: 'Background work: 2 tasks · 00:30', running: 2 });
});

test('the activity line adds the tokens the running tasks reported', () => {
  const tasks = [task({ started: 0, tokens: 412_000 }), task({ started: 10 })];
  expect(activityLine(activity(tasks), { now: START + 30_000 })?.text).toBe('Background work: 2 tasks · 412k tokens · 00:30');
});

test('a running workflow names the line, with its own elapsed time and tokens, and counts the other background tasks', () => {
  const flow = workflow({ started: 10, tokens: 1_200_000 });
  expect(activityLine(activity([flow]), { now: START + 40_000 })).toEqual({ text: 'Workflow demo · 00:30 · 1.2M tokens', running: 1 });
  expect(activityLine(activity([task({ started: 0, tokens: 5_000 }), flow]), { now: START + 40_000 })).toEqual({ text: 'Workflow demo · 00:30 · 1.2M tokens · 1 other task', running: 2 });
  expect(activityLine(activity([task(), task(), workflow({ started: 10 })]), { now: START + 40_000 })?.text).toBe('Workflow demo · 00:30 · 2 other tasks');
  // Without a name, its description; the newest of several running workflows names the line.
  expect(activityLine(activity([workflow({ workflowName: 'older', started: 0 }), workflow({ workflowName: null, description: 'Review the diff', started: 20 })]), { now: START + 40_000 })?.text).toBe('Workflow Review the diff · 00:20 · 1 other task');
  // A finished workflow names nothing.
  expect(activityLine(activity([workflow({ status: 'completed', ended: 5 }), task({ started: 10 })]), { now: START + 40_000 })?.text).toBe('Background work: 1 task · 00:30');
});

test('a running workflow whose progress reported its agents names its phase and how many agents are done', () => {
  const flow = workflow({ started: 10, tokens: 20_388, workflow: progress([phase('Say', { agents: 2, done: 1, running: 1 })], null, 'Say: say:1') });
  expect(activityLine(activity([flow]), { now: START + 40_000 })).toEqual({ text: 'Workflow demo: Say 1/2 · 00:30 · 20k tokens', running: 1 }); // 20388 tokens read as formatTokens has them
  expect(activityLine(activity([task({ started: 0 }), flow]), { now: START + 40_000 })).toEqual({ text: 'Workflow demo: Say 1/2 · 00:30 · 20k tokens · 1 other task', running: 2 });
  const line = (/** @type {ReturnType<typeof progress>} */ summary) => activityLine(activity([workflow({ started: 10, workflow: summary })]), { now: START + 40_000 })?.text;
  // The phase is the first with running agents, else the last with a done or failed agent, else the first.
  expect(line(progress([phase('Plan', { agents: 1, done: 1 }), phase('Build', { agents: 2, done: 1, running: 1 }), phase('Verify', { agents: 1, running: 1 })]))).toBe('Workflow demo: Build 2/4 · 00:30');
  expect(line(progress([phase('Plan', { agents: 1, done: 1 }), phase('Build', { agents: 1, failed: 1 }), phase('Verify')]))).toBe('Workflow demo: Build 1/2 · 00:30');
  expect(line(progress([phase('Plan'), phase('Build')]))).toBe('Workflow demo: Plan 0/0 · 00:30');
  // Agents reported without phases: the counts alone.
  expect(line(progress([], { total: 2, running: 1, done: 1, failed: 0 }))).toBe('Workflow demo: 1/2 · 00:30');
  // No progress report of its agents (none yet, or an engine from before them): the line says no counts.
  expect(line(null)).toBe('Workflow demo · 00:30');
});

test("a workflow phase's status: failed on any failed agent, running while one runs, done when all are, else pending", () => {
  expect(workflowPhaseStatus(phase('Say'))).toBe('pending');
  expect(workflowPhaseStatus(phase('Say', { agents: 2 }))).toBe('pending');
  expect(workflowPhaseStatus(phase('Say', { agents: 2, done: 1, running: 1 }))).toBe('running');
  expect(workflowPhaseStatus(phase('Say', { agents: 2, done: 2 }))).toBe('done');
  expect(workflowPhaseStatus(phase('Say', { agents: 3, done: 1, running: 1, failed: 1 }))).toBe('failed');
});

test("a phase still reported running on a workflow that ended takes the workflow's own end word", () => {
  const working = phase('Say', { agents: 2, done: 1, running: 1 });
  expect(workflowPhaseStatus(working, 'running')).toBe('running');
  expect(workflowPhaseStatus(working, 'stopped')).toBe('stopped');
  expect(workflowPhaseStatus(working, 'failed')).toBe('failed');
  expect(workflowPhaseStatus(working, 'completed')).toBe('done');
  // What the report settled stays what it was: a failed agent, all of them done, none started.
  expect(workflowPhaseStatus(phase('Say', { agents: 2, done: 1, failed: 1 }), 'stopped')).toBe('failed');
  expect(workflowPhaseStatus(phase('Say', { agents: 2, done: 2 }), 'stopped')).toBe('done');
  expect(workflowPhaseStatus(phase('Verify'), 'stopped')).toBe('pending');
});

test('a token count of 0 is left out of the line: no agent or task has reported spend yet', () => {
  const flow = workflow({ started: 10, tokens: 0, workflow: progress([phase('Say', { agents: 2, running: 2 })], null, 'Say: say:1') });
  expect(activityLine(activity([flow]), { now: START + 40_000 })?.text).toBe('Workflow demo: Say 0/2 · 00:30');
  expect(activityLine(activity([task({ started: 0, tokens: 0 }), task({ started: 10, tokens: 0 })]), { now: START + 30_000 })?.text).toBe('Background work: 2 tasks · 00:30');
});

test("a workflow's summary is known only once its progress reported its agents, and Large past the threshold", () => {
  expect(LARGE_RUN_AGENTS).toBe(25);
  const phases = [phase('Say', { agents: 2, done: 1, running: 1 })];
  expect(workflowSummary(workflow({ workflow: progress(phases, null, 'Say: say:1') }))).toEqual({ agents: 2, phases, current: 'Say: say:1', large: false });
  const fanOut = (/** @type {number} */ total) => workflowSummary(workflow({ workflow: progress([phase('Fan out', { agents: total, running: total })]) })).large;
  expect(fanOut(LARGE_RUN_AGENTS)).toBe(false);
  expect(fanOut(LARGE_RUN_AGENTS + 1)).toBe(true);
  expect(workflowSummary(workflow({ workflow: null }))).toEqual({ agents: null, phases: [], current: null, large: false });
  expect(workflowSummary(workflow())).toEqual({ agents: null, phases: [], current: null, large: false }); // an engine from before it
});

test('during a turn a foreground subagent is the turn\'s own; once the turn ends, any task still running is background work', () => {
  const options = { now: START + 30_000 };
  const foreground = task({ backgrounded: false, started: 0, tokens: 9_000 });
  expect(activityLine(activity([foreground], 'working'), options)).toBeNull();
  expect(activityLine(activity([foreground, task({ started: 10 })], 'working'), options)).toEqual({ text: 'Background work: 1 task · 00:20', running: 1 });
  expect(activityLine(activity([foreground], 'background'), options)).toEqual({ text: 'Background work: 1 task · 9.0k tokens · 00:30', running: 1 });
});

test('the Panels menu counts the same background tasks the line does', () => {
  const foreground = task({ backgrounded: false });
  const background = task();
  expect(backgroundTasks(activity([foreground, background, task({ status: 'completed', ended: 3 })], 'working'))).toEqual([background]);
  expect(backgroundTasks(activity([foreground, background], 'background'))).toEqual([foreground, background]);
  expect(backgroundTasks(null)).toEqual([]);
});

test('the activity line is absent when nothing runs', () => {
  expect(activityLine(activity([task({ status: 'completed', ended: 3 })]), { now: START })).toBeNull();
  expect(activityLine(null, { now: START })).toBeNull();
});

test('a read of the activity keeps a newer snapshot that arrived meanwhile, and replaces an older one', () => {
  const older = { ...activity([task()]), updatedAt: at(1) };
  const newer = { ...activity([]), updatedAt: at(2) };
  expect(newerActivity(newer, older)).toBe(newer);
  expect(newerActivity(older, newer)).toBe(newer);
  expect(newerActivity(null, older)).toBe(older);
});

test('a read that finds no process keeps a snapshot that arrived meanwhile: the selection cleared the old one first', () => {
  const newer = { ...activity([task()]), updatedAt: at(2) };
  expect(newerActivity(newer, null)).toBe(newer);
  expect(newerActivity(null, null)).toBeNull();
});

test('a stop belongs to the conversation that sent it: another one shows neither its wait nor its reply', () => {
  const result = { requested: 2, stopped: 0, escalated: true, taskIds: ['t1', 't2'] };
  expect(stopFor({ sessionId: 'a', pending: true, result: null }, 'a')).toEqual({ stopping: true, stopResult: null });
  expect(stopFor({ sessionId: 'a', pending: true, result: null }, 'b')).toEqual({ stopping: false, stopResult: null });
  expect(stopFor({ sessionId: 'a', pending: false, result }, 'a')).toEqual({ stopping: false, stopResult: result });
  expect(stopFor({ sessionId: 'a', pending: false, result }, 'b')).toEqual({ stopping: false, stopResult: null });
  expect(stopFor(null, 'a')).toEqual({ stopping: false, stopResult: null });
});

test('Review Focus 4: a force-stop is offered only while a stop with leftovers still has its own tasks running', () => {
  const stuck = [task(), task()];
  const taskIds = stuck.map(item => item.taskId);
  expect(forceStopOffered(activity(stuck), { requested: 2, stopped: 0, escalated: true, taskIds })).toBe(true);
  expect(forceStopOffered(activity(stuck), { requested: 2, stopped: 0, escalated: false, taskIds })).toBe(true);
  expect(forceStopOffered(activity(stuck), null)).toBe(false);
  expect(forceStopOffered(activity(stuck), { requested: 2, stopped: 2, escalated: false, taskIds })).toBe(false);
  expect(forceStopOffered(null, { requested: 2, stopped: 0, escalated: true, taskIds })).toBe(false);
  const ended = stuck.map(item => ({ ...item, status: /** @type {const} */ ('failed'), endedAt: at(9) }));
  expect(forceStopOffered(activity([...ended, task()]), { requested: 2, stopped: 0, escalated: true, taskIds })).toBe(false);
});

test('a count reads in the singular for one', () => {
  expect(plural(1, 'task')).toBe('1 task');
  expect(plural(3, 'task')).toBe('3 tasks');
  expect(plural(0, 'agent')).toBe('0 agents');
});

test('tokens and elapsed time read compactly', () => {
  expect(formatTokens(850)).toBe('850');
  expect(formatTokens(412_000)).toBe('412k');
  expect(formatTokens(1_200_000)).toBe('1.2M');
  expect(formatElapsed(372_000)).toBe('06:12');
  expect(formatElapsed(3_849_000)).toBe('1:04:09');
});

