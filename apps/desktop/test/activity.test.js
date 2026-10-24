import { expect, test } from 'bun:test';
import { LARGE_RUN_AGENTS, activityLine, agentStatus, childRows, agentsByPhase, backgroundTasks, clearFinished, forceStopOffered, formatElapsed, formatTokens, groupActivity, nestTasks, newerActivity, phaseSquares, plural, runningTasks, squaresInWords, statusWord, stopFor, taskDetail, taskKind, workflowPhaseStatus, workflowSummary } from '../src/renderer/activity.js';

const START = Date.parse('2026-10-24T10:00:00.000Z');
const at = (seconds) => new Date(START + seconds * 1000).toISOString();
let ids = 0;
/** @typedef {import('../src/renderer/activity.js').TaskRecord} TaskRecord */
/** @param {Record<string, any>} [options] @returns {TaskRecord} */
const task = ({ runId = null, phase = null, status = 'running', started = 0, ended = null, tokens = null, toolUseId = null, description = 'A task', backgrounded = true, taskType = null, workflowName = null, subagentType = null, workflow = undefined, ...detail } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId, description, subagentType, taskType, workflowName, phase, backgrounded, status,
  startedAt: at(started), endedAt: ended === null ? null : at(ended), usage: { totalTokens: tokens, toolUses: null, durationMs: null }, workflow, ...detail,
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

test('the panel lists the running tasks, then the finished ones, each newest first, workflows among the rest whatever run ids they carry', () => {
  const oldDone = task({ status: 'completed', started: 1, ended: 2, runId: 'r1' });
  const newDone = task({ status: 'stopped', started: 5, ended: 6, runId: 'r2' });
  const oldRunning = task({ started: 2, runId: 'r3' });
  const newRunning = task({ started: 4, runId: 'r4' });
  const doneFlow = workflow({ status: 'failed', started: 0, ended: 9 });
  const oldFlow = workflow({ started: 1 });
  const newFlow = workflow({ started: 3 });
  const { running, finished } = groupActivity(activity([doneFlow, oldDone, oldFlow, oldRunning, newRunning, newFlow, newDone]));
  expect(running).toEqual([newRunning, newFlow, oldRunning, oldFlow]);
  expect(finished).toEqual([newDone, oldDone, doneFlow]);
});

test('groupActivity of no activity is empty', () => {
  expect(groupActivity(null)).toEqual({ running: [], finished: [] });
});

test('Review Focus 3: two hundred tasks, sixteen of them workflows, group in one pass', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => index < 16 ? workflow({ started: index }) : task({ runId: `run-${index}`, started: index, tokens: 1000, status: index % 4 ? 'running' : 'completed', ended: index % 4 ? null : index }));
  const grouped = groupActivity(activity(tasks));
  expect(grouped.running).toHaveLength(154);
  expect(grouped.finished).toHaveLength(46);
});

test('Clear finished hides the finished tasks listed then, never one that runs again, ended again, or ended since', () => {
  const done = task({ status: 'completed', started: 1, ended: 2 });
  const stopped = workflow({ status: 'stopped', started: 2, ended: 3 });
  const running = task({ started: 3 });
  const cleared = clearFinished(activity([done, stopped, running]), {});
  expect(cleared).toEqual({ [done.taskId]: at(2), [stopped.taskId]: at(3) }); // each with when it ended
  expect(groupActivity(activity([done, stopped, running]), cleared)).toEqual({ running: [running], finished: [] });
  const later = task({ status: 'failed', started: 4, ended: 5 });
  const again = { ...done, status: /** @type {const} */ ('running'), endedAt: null };
  expect(groupActivity(activity([again, stopped, running, later]), cleared)).toEqual({ running: [running, again], finished: [later] });
  const endedAgain = { ...done, endedAt: at(8) };
  expect(groupActivity(activity([endedAgain, stopped]), cleared)).toEqual({ running: [], finished: [endedAgain] });
  // A later Clear finished keeps what the earlier one hid.
  expect(clearFinished(activity([later]), cleared)).toEqual({ ...cleared, [later.taskId]: at(5) });
  expect(clearFinished(null, cleared)).toEqual(cleared);
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
  expect(grouped).toEqual({ running: [sleep], finished: [] });
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

test("a phase has a square per agent: done, running, failed, then pending (the report counts them, it does not order them)", () => {
  expect(phaseSquares(phase('Read', { agents: 5, done: 5 }))).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(phaseSquares(phase('Build', { agents: 5, done: 1, running: 1, failed: 1 }))).toEqual(['done', 'running', 'failed', 'pending', 'pending']);
  expect(phaseSquares(phase('Ship'))).toEqual([]);
  // Counts past the agents never make a negative number of pending ones.
  expect(phaseSquares(phase('Odd', { agents: 1, done: 1, running: 1 }))).toEqual(['done', 'running']);
});

test("an agent still reported running on a workflow that ended takes the workflow's own end word", () => {
  const working = phase('Say', { agents: 3, done: 1, running: 1 });
  expect(phaseSquares(working, 'running')).toEqual(['done', 'running', 'pending']);
  expect(phaseSquares(working, 'stopped')).toEqual(['done', 'stopped', 'pending']);
  expect(phaseSquares(working, 'failed')).toEqual(['done', 'failed', 'pending']);
  expect(phaseSquares(working, 'completed')).toEqual(['done', 'done', 'pending']);
});

test("a task's status reads as a word, and squares read as counts of each status they have, in the order they first appear", () => {
  expect(['running', 'completed', 'stopped', 'failed'].map(status => statusWord(/** @type {TaskRecord['status']} */ (status)))).toEqual(['Running', 'Completed', 'Stopped', 'Failed']);
  expect(squaresInWords(['done', 'running', 'pending', 'pending'])).toBe('1 done, 1 running, 2 pending');
  expect(squaresInWords(['stopped', 'stopped'])).toBe('2 stopped');
  expect(squaresInWords([])).toBe('');
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

test('a list draws each task under the listed task that started it, one level deep, and one whose parent is not listed at the top', () => {
  // As groupActivity lists them, newest first: a subagent, its command, the command's own command, and a task whose
  // parent is in no list (finished, cleared or forgotten).
  const other = task({ started: 0 });
  const agent = task({ started: 1, taskType: 'local_agent', spawnDepth: 1 });
  const command = task({ started: 2, taskType: 'local_bash', parentTaskId: agent.taskId });
  const deeper = task({ started: 3, taskType: 'local_bash', parentTaskId: command.taskId });
  const orphan = task({ started: 4, parentTaskId: 'gone' });
  expect(nestTasks([orphan, deeper, command, agent, other])).toEqual([
    { task: orphan, nested: false },
    { task: agent, nested: false }, { task: deeper, nested: true }, { task: command, nested: true }, // deeper levels flatten to one
    { task: other, nested: false },
  ]);
  // Tasks naming each other, or themselves, are nobody's child; a task from an engine from before parents stands alone.
  const first = task({ started: 5 });
  const second = task({ started: 6, parentTaskId: first.taskId });
  first.parentTaskId = second.taskId;
  const itself = task({ started: 7 });
  itself.parentTaskId = itself.taskId;
  const older = task({ started: 8 });
  expect(nestTasks([older, itself, second, first]).map(item => item.nested)).toEqual([false, false, false, false]);
  expect(nestTasks([])).toEqual([]);
});

test('what a running task does now is its progress line, else the tool it last used; an older engine says neither', () => {
  expect(taskDetail(task({ progress: 'Running Sleep 75 seconds then print ok', lastTool: 'Bash' }))).toEqual({ now: 'Running Sleep 75 seconds then print ok', tool: null, summary: null, output: null });
  expect(taskDetail(task({ progress: null, lastTool: 'Bash' }))).toEqual({ now: null, tool: 'Bash', summary: null, output: null });
  expect(taskDetail(task({ progress: '', lastTool: '' }))).toEqual({ now: null, tool: null, summary: null, output: null });
  expect(taskDetail(task())).toEqual({ now: null, tool: null, summary: null, output: null });
  // A summary or an output file is how a task ended: a running one shows neither.
  expect(taskDetail(task({ summary: 'done early', outputFile: '/tmp/a.output' }))).toEqual({ now: null, tool: null, summary: null, output: null });
});

test('how a task ended is its summary when that says more than its description, and its output file by name', () => {
  const ended = (/** @type {Record<string, any>} */ detail) => taskDetail(task({ status: 'completed', ended: 5, description: 'Run 75s sleep command', progress: 'Running Sleep 75 seconds then print ok', lastTool: 'Bash', ...detail }));
  expect(ended({ summary: 'Run 75s sleep command', outputFile: '/private/tmp/claude-501/x/tasks/a47340cffe7ba1185.output' })).toEqual({ now: null, tool: null, summary: null, output: { name: 'a47340cffe7ba1185.output', path: '/private/tmp/claude-501/x/tasks/a47340cffe7ba1185.output' } });
  expect(ended({ summary: 'Slept, then printed ok', outputFile: null })).toEqual({ now: null, tool: null, summary: 'Slept, then printed ok', output: null });
  expect(ended({ outputFile: 'C:\\Temp\\tasks\\out.txt' }).output).toEqual({ name: 'out.txt', path: 'C:\\Temp\\tasks\\out.txt' });
  expect(ended({ outputFile: '/tmp/tasks/' }).output).toEqual({ name: 'tasks', path: '/tmp/tasks/' });
  expect(ended({})).toEqual({ now: null, tool: null, summary: null, output: null }); // an older engine
});

/** A workflow agent as the engine lists it, with its phase's title and index. */
const agentOf = (/** @type {string} */ label, /** @type {string | null} */ phaseTitle, /** @type {'running' | 'done' | 'failed'} */ state, /** @type {number | null} */ phaseIndex = null) => ({ label, phase: phaseTitle, phaseIndex, state, model: 'claude-fable-5-1', tokens: null, toolCalls: null, durationMs: null, resultPreview: null });
/** A workflow whose summary lists `list`. */
const listing = (/** @type {ReturnType<typeof phase>[]} */ phases, /** @type {ReturnType<typeof agentOf>[]} */ list) => {
  const summary = progress(phases);
  return workflow({ workflow: { ...summary, agents: { ...summary.agents, list } } });
};

test("a workflow phase's agents are those its progress listed under the phase's index; none without a list", () => {
  // Two phases with one title: each has its own agents.
  const review = { ...phase('Review', { agents: 1, running: 1 }), index: 1 };
  const again = { ...phase('Review', { agents: 2, done: 1, running: 1 }), index: 2 };
  const list = [agentOf('first:1', 'Review', 'running', 1), agentOf('second:1', 'Review', 'done', 2), agentOf('second:2', 'Review', 'running', 2), agentOf('lost', null, 'failed')];
  const agentsOf = agentsByPhase(listing([review, again], list));
  expect(agentsOf?.(review)).toEqual([list[0]]);
  expect(agentsOf?.(again)).toEqual([list[1], list[2]]);
  expect(agentsOf?.({ ...phase('Ship'), index: 3 })).toEqual([]);
  const summary = progress([review]);
  expect(agentsByPhase(workflow({ workflow: summary }))).toBeNull(); // an engine from before the list
  expect(agentsByPhase(workflow({ workflow: null }))).toBeNull();
  expect(agentsByPhase(workflow())).toBeNull();
});

test("an agent that names no phase index, or a phase that has none, is matched by the phase's title", () => {
  const say = { ...phase('Say', { agents: 2, running: 2 }), index: 1 };
  const list = [agentOf('say:1', 'Say', 'running', 1), agentOf('say:2', 'Say', 'running'), agentOf('check:1', 'Check', 'running')];
  const agentsOf = agentsByPhase(listing([say], list));
  expect(agentsOf?.(say)).toEqual([list[0], list[1]]);
  // A phase without an index (an engine before phase indexes) takes every agent under its title.
  expect(agentsByPhase(listing([phase('Say')], list))?.(phase('Say'))).toEqual([list[0], list[1]]);
});

test("an agent's status is its state; one still running on a workflow that ended takes the workflow's own end word", () => {
  expect(agentStatus(agentOf('a', 'Say', 'running'))).toBe('running');
  expect(agentStatus(agentOf('a', 'Say', 'done'), 'stopped')).toBe('done');
  expect(agentStatus(agentOf('a', 'Say', 'failed'), 'completed')).toBe('failed');
  expect(agentStatus(agentOf('a', 'Say', 'running'), 'stopped')).toBe('stopped');
  expect(agentStatus(agentOf('a', 'Say', 'running'), 'failed')).toBe('failed');
  expect(agentStatus(agentOf('a', 'Say', 'running'), 'completed')).toBe('done');
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


/** A child task as the board lists it, and its delegation row. @param {Record<string, any>} [options] */
const child = ({ sessionId = `ses_${++ids}`, title = 'Write the parser tests', state = 'completed', updated = 0, runUpdated = updated, attention = null } = {}) => ({
  sessionId, title, attention, updatedAt: at(updated), answerer: { displayName: 'Claude Code', model: 'opus' },
  run: state ? { id: `run_${sessionId}`, state, updatedAt: at(runUpdated), execution: { agentId: 'claude', model: 'opus' } } : null,
});
const delegation = (/** @type {string} */ sessionId, /** @type {Record<string, any>} */ fields = {}) => ({ id: `del_${sessionId}`, sessionId, runId: `run_${sessionId}`, state: 'completed', activity: 'idle', done: true, partial: false, wakeReason: null, failure: null, createdAt: at(0), ...fields });

test('child rows: running ones first, then the rest, each newest first; running while its run is live or its process works', () => {
  const live = child({ title: 'live', state: 'model', updated: 10 });
  const background = child({ title: 'background', updated: 5 });
  const older = child({ title: 'older', updated: 1 });
  const newer = child({ title: 'newer', updated: 20 });
  const rows = childRows([older, live, newer, background], new Map([[background.sessionId, delegation(background.sessionId, { activity: 'background' })]]), START + 60_000);
  expect(rows.map(row => [row.task.title, row.running])).toEqual([['live', true], ['background', true], ['newer', false], ['older', false]]);
});

test('a child\'s elapsed time runs from its delegation\'s start, stops with its run, and is blank without a delegation row', () => {
  const running = child({ state: 'tools', updated: 30 });
  const ended = child({ state: 'completed', updated: 50, runUpdated: 190 });
  const unknown = child({ state: 'model' });
  const delegations = new Map([[running.sessionId, delegation(running.sessionId, { state: 'running', activity: 'working', createdAt: at(18) })], [ended.sessionId, delegation(ended.sessionId)]]);
  const [first, second, third] = childRows([running, ended, unknown], delegations, START + 60_000);
  expect([first.task, first.elapsed]).toEqual([running, '00:42']);
  expect([third.task, third.elapsed]).toEqual([ended, '03:10']);
  expect([second.task, second.elapsed, second.delegation]).toEqual([unknown, '', null]);
});

test('a child is stopped through its live run, else through the delegation\'s run while its process works; one that ended has no stop', () => {
  const live = child({ state: 'model' });
  const working = child({ state: 'completed' });
  const background = child({ state: 'completed' });
  const ended = child({ state: 'completed' });
  const delegations = new Map([[working.sessionId, delegation(working.sessionId, { runId: 'run_delegated', activity: 'working' })], [background.sessionId, delegation(background.sessionId, { activity: 'background' })], [ended.sessionId, delegation(ended.sessionId)]]);
  const stops = Object.fromEntries(childRows([live, working, background, ended], delegations, START).map(row => [row.task.sessionId, row.stopRunId]));
  expect(stops).toEqual({ [live.sessionId]: live.run.id, [working.sessionId]: 'run_delegated', [background.sessionId]: null, [ended.sessionId]: null });
});

test('the activity line counts working child tasks: alone, after the background work, or not at all', () => {
  expect(activityLine(activity([]), { now: START + 42_000, children: 1, childrenSince: START })).toEqual({ text: '1 child task working · 00:42', running: 0 });
  expect(activityLine(null, { now: START + 42_000, children: 2, childrenSince: START })?.text).toBe('2 child tasks working · 00:42');
  expect(activityLine(activity([]), { now: START, children: 1 })?.text).toBe('1 child task working');
  expect(activityLine(activity([task({ started: 0 })]), { now: START + 30_000, children: 1, childrenSince: START })).toEqual({ text: 'Background work: 1 task · 00:30 · 1 child task', running: 1 });
  expect(activityLine(activity([workflow({ started: 10 })]), { now: START + 40_000, children: 2 })?.text).toBe('Workflow demo · 00:30 · 2 child tasks');
  expect(activityLine(activity([]), { now: START, children: 0 })).toBeNull();
  expect(activityLine(activity([]), { now: START })).toBeNull();
});
