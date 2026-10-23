import { expect, test } from 'bun:test';
import { LARGE_RUN_AGENTS, activityLine, formatElapsed, formatTokens, groupActivity, parseWorkflowName, runningTasks, workflowNames } from '../src/renderer/activity.js';

const START = Date.parse('2026-10-24T10:00:00.000Z');
const at = (seconds) => new Date(START + seconds * 1000).toISOString();
let ids = 0;
/** @typedef {import('../src/renderer/activity.js').TaskRecord} TaskRecord */
/** @param {Record<string, any>} [options] @returns {TaskRecord} */
const task = ({ runId = null, phase = null, status = 'running', started = 0, ended = null, tokens = null, toolUseId = null, description = 'A task' } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId, description, subagentType: null, phase, backgrounded: true, status,
  startedAt: at(started), endedAt: ended === null ? null : at(ended), usage: { totalTokens: tokens, toolUses: null, durationMs: null },
});
/** @param {TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks) => ({ state: 'background', tasks, truncated: false, updatedAt: at(0) });

test('runningTasks keeps the running ones and reads nothing from no activity', () => {
  const running = task();
  expect(runningTasks(activity([running, task({ status: 'completed', ended: 5 })]))).toEqual([running]);
  expect(runningTasks(null)).toEqual([]);
});

test('a workflow run is the tasks that share a run id, with one status per distinct phase and the tokens they reported', () => {
  const { runs, tasks } = groupActivity(activity([
    task({ runId: 'wf1', phase: 'Review', status: 'completed', started: 0, ended: 10, tokens: 1000 }),
    task({ runId: 'wf1', phase: 'Review', started: 1, tokens: 2000 }),
    task({ runId: 'wf1', phase: 'Verify', started: 2 }),
  ]));
  expect(tasks).toEqual([]);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    runId: 'wf1', agents: 3, startedAt: at(0), endedAt: null, running: true, tokens: 3000, large: false,
    phases: [{ name: 'Review', status: 'running' }, { name: 'Verify', status: 'running' }],
  });
  expect(runs[0].tasks).toHaveLength(3);
});

test('a phase is red when any of its agents failed or stopped and green when all completed', () => {
  const { runs: [run] } = groupActivity(activity([
    task({ runId: 'wf', phase: 'Plan', status: 'completed', ended: 3 }),
    task({ runId: 'wf', phase: 'Build', status: 'stopped', ended: 4 }),
    task({ runId: 'wf', phase: 'Build', status: 'completed', ended: 5 }),
  ]));
  expect(run.phases).toEqual([{ name: 'Plan', status: 'done' }, { name: 'Build', status: 'failed' }]);
  expect(run).toMatchObject({ running: false, endedAt: at(5), tokens: null });
});

test('a run without phases has one status per agent, and more than LARGE_RUN_AGENTS agents make it large', () => {
  const { runs: [small] } = groupActivity(activity([task({ runId: 'wf' }), task({ runId: 'wf', status: 'completed', ended: 2 }), task({ runId: 'wf', status: 'failed', ended: 3 })]));
  expect(small.phases).toEqual([{ name: null, status: 'running' }, { name: null, status: 'done' }, { name: null, status: 'failed' }]);
  expect(LARGE_RUN_AGENTS).toBe(25);
  const { runs: [atLimit] } = groupActivity(activity(Array.from({ length: 25 }, () => task({ runId: 'wf' }))));
  expect(atLimit.large).toBe(false);
  const { runs: [large] } = groupActivity(activity(Array.from({ length: 26 }, () => task({ runId: 'wf' }))));
  expect(large).toMatchObject({ agents: 26, large: true });
});

test('runs are ordered by their first start, standalone tasks come running first and newest first', () => {
  const oldDone = task({ status: 'completed', started: 1, ended: 2 });
  const newDone = task({ status: 'completed', started: 5, ended: 6 });
  const oldRunning = task({ started: 2 });
  const newRunning = task({ started: 4 });
  const { runs, tasks } = groupActivity(activity([
    task({ runId: 'late', started: 3 }), task({ runId: 'early', started: 0 }), oldDone, oldRunning, newRunning, newDone, task({ runId: 'late', started: 7 }),
  ]));
  expect(runs.map(run => run.runId)).toEqual(['early', 'late']);
  expect(tasks).toEqual([newRunning, oldRunning, newDone, oldDone]);
});

test('groupActivity of no activity is empty', () => {
  expect(groupActivity(null)).toEqual({ runs: [], tasks: [] });
});

test('Review Focus 3: two hundred tasks across sixteen runs group in one pass', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => task({ runId: index < 192 ? `wf${index % 16}` : null, phase: index % 2 ? 'Review' : 'Verify', started: index, tokens: 1000 }));
  const grouped = groupActivity(activity(tasks));
  expect(grouped.runs).toHaveLength(16);
  expect(grouped.runs.every(run => run.agents === 12 && run.tokens === 12_000)).toBe(true);
  expect(grouped.tasks).toHaveLength(8);
});

test('the activity line counts background tasks and their elapsed time, without tokens nobody reported', () => {
  const tasks = [task({ started: 0 }), task({ started: 10 })];
  expect(activityLine(activity(tasks), { now: START + 30_000, workflowNames: new Map() })).toEqual({ text: 'Background work: 2 tasks · 00:30', running: 2 });
});

test('the activity line adds the tokens the running tasks reported', () => {
  const tasks = [task({ started: 0, tokens: 412_000 }), task({ started: 10 })];
  expect(activityLine(activity(tasks), { now: START + 30_000, workflowNames: new Map() })?.text).toBe('Background work: 2 tasks · 412k tokens · 00:30');
});

test('the activity line names an open workflow run with the phase of its newest running agent and the agents finished', () => {
  const tasks = [
    ...Array.from({ length: 37 }, (_, index) => task({ runId: 'wf', phase: 'Review', status: 'completed', started: index, ended: 100 + index, tokens: 20_000 })),
    ...Array.from({ length: 82 }, (_, index) => task({ runId: 'wf', phase: 'Review', started: 40 + index, tokens: 5_000 })),
    task({ runId: 'wf', phase: 'Verify', started: 200, tokens: 50_000 }),
  ];
  expect(activityLine(activity(tasks), { now: START + 300_000, workflowNames: new Map([['wf', 'review']]) })).toEqual({ text: 'Workflow review: Verify 37/120 · 1.2M tokens', running: 83 });
});

test('a workflow run without phases or a known name reads as its agents under its first description', () => {
  const tasks = [task({ runId: 'wf', description: 'Check the API', started: 0 }), task({ runId: 'wf', description: 'Check the UI', started: 1 })];
  expect(activityLine(activity(tasks), { now: START + 5_000, workflowNames: new Map() })?.text).toBe('Workflow Check the API: 2 agents');
});

test('the activity line is absent when nothing runs', () => {
  expect(activityLine(activity([task({ status: 'completed', ended: 3 })]), { now: START, workflowNames: new Map() })).toBeNull();
  expect(activityLine(null, { now: START, workflowNames: new Map() })).toBeNull();
});

test('tokens and elapsed time read compactly', () => {
  expect(formatTokens(850)).toBe('850');
  expect(formatTokens(412_000)).toBe('412k');
  expect(formatTokens(1_200_000)).toBe('1.2M');
  expect(formatElapsed(372_000)).toBe('06:12');
  expect(formatElapsed(3_849_000)).toBe('1:04:09');
});

test('a workflow name comes from its meta, else its script path, and survives a cut-off head', () => {
  expect(parseWorkflowName('Workflow {"script":"export const meta = { name: \'review-changes\', description: \'x\' }"}\n...')).toBe('review-changes');
  expect(parseWorkflowName('Workflow {"scriptPath":"/a/b/plan-review.js"}\nStarted')).toBe('plan-review');
  expect(parseWorkflowName('Bash {"command":"ls"}\nfile.txt')).toBeNull();
  expect(parseWorkflowName('Workflow {"script":"export const meta = { name: \'review-changes\', descr')).toBe('review-changes');
});

test('a workflow name is joined to its run by the tool call id, then the run id in a message, then the single pair', () => {
  const wf = (runId, toolUseId = null) => groupActivity(activity([task({ runId, toolUseId })])).runs[0];
  const byCall = wf('wf_1', 'toolu_wf');
  const tools = [{ callId: 'toolu_wf', name: 'Workflow', preview: 'Workflow {"script":"export const meta = { name: \'by-call\'' }];
  const message = (id, text) => ({ id, runId: 'run', kind: 'tool', text, status: 'complete' });
  const byRunId = message('m1', 'Workflow {"script":"export const meta = { name: \'by-run-id\' }"}\nStarted workflow run wf_2');
  expect(workflowNames([byRunId], tools, [byCall, wf('wf_2')])).toEqual(new Map([['wf_1', 'by-call'], ['wf_2', 'by-run-id']]));
  const single = message('m2', 'Workflow {"scriptPath":"/w/single.js"}\nStarted');
  expect(workflowNames([single], [], [wf('wf_3')])).toEqual(new Map([['wf_3', 'single']]));
  expect(workflowNames([single, message('m3', 'Workflow {"scriptPath":"/w/other.js"}\nStarted')], [], [wf('wf_4')])).toEqual(new Map());
});
