import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityLine } from '../src/renderer/components/activity-line.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', backgrounded = true, taskType = null, workflowName = null, tokens = null, workflow = undefined } = {}) => ({
  taskId: `t${++ids}`, runId: `run-${ids}`, toolUseId: null, description: 'A task', subagentType: null, taskType, workflowName, phase: null, backgrounded, status,
  startedAt: new Date().toISOString(), endedAt: status === 'running' ? null : new Date().toISOString(), usage: { totalTokens: tokens, toolUses: null, durationMs: null }, workflow,
});
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @param {import('../src/renderer/activity.js').Activity['state']} [state] @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks, state = 'background') => ({ state, tasks, truncated: false, updatedAt: new Date().toISOString() });
const render = (value, stopping = false) => renderToStaticMarkup(<ActivityLine activity={value} onStop={() => {}} onOpenPanel={() => {}} stopping={stopping} />);

test('two background tasks read as one line that opens the Activity panel and stops all of them', () => {
  const html = render(activity([task(), task()]));
  expect(html).toContain('class="activity-line" role="status"');
  expect(html).toContain('aria-label="Show background work"');
  expect(html).toContain('Background work: 2 tasks');
  expect(html).toMatch(/<button[^>]*>Stop background work<\/button>/);
});

test('two background commands, each with a run id of its own, are two tasks, not workflows', () => {
  const html = render(activity([task({ taskType: 'local_bash' }), task({ taskType: 'local_bash' })]));
  expect(html).toContain('Background work: 2 tasks');
  expect(html).not.toContain('Workflow');
});

test('a running workflow names the line', () => {
  const html = render(activity([task({ taskType: 'local_workflow', workflowName: 'demo' })]));
  expect(html).toMatch(/>Workflow demo · \d\d:\d\d</);
});

test('a running workflow whose progress reported its agents adds its phase and how many agents are done', () => {
  const workflow = { phases: [{ title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }], agents: { total: 2, running: 1, done: 1, failed: 0 }, current: 'Say: say:1' };
  const html = render(activity([task({ taskType: 'local_workflow', workflowName: 'demo', tokens: 20_388, workflow })]));
  expect(html).toMatch(/>Workflow demo: Say 1\/2 · \d\d:\d\d · 20k tokens</);
});

test('nothing is lit while no background task runs, a foreground subagent during the turn included', () => {
  expect(render(null)).toBe('');
  expect(render(activity([task({ status: 'completed' })]))).toBe('');
  expect(render(activity([task({ backgrounded: false })], 'working'))).toBe('');
  expect(render(activity([task({ backgrounded: false })], 'background'))).toContain('Background work: 1 task');
});

test('while the stop is pending its button reads Stopping… and is disabled', () => {
  const html = render(activity([task(), task()]), true);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
  expect(html).not.toContain('Stop background work');
});
