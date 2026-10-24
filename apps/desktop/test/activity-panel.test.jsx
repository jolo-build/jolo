import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel, ForceStopDialog } from '../src/renderer/components/activity-panel.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', runId = null, phase = null, subagentType = null, taskType = null, workflowName = null, description = 'A task', tokens = null, startedAt = new Date().toISOString(), endedAt = status === 'running' ? null : new Date().toISOString() } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId: null, description, subagentType, taskType, workflowName, phase, backgrounded: true, status,
  startedAt, endedAt, usage: { totalTokens: tokens, toolUses: null, durationMs: null },
});
/** A workflow as Claude Code 2.1.304 reports one: one task of type local_workflow. @param {Record<string, any>} [options] */
const workflow = (options = {}) => task({ taskType: 'local_workflow', ...options });
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks, truncated = false) => ({ state: 'background', tasks, truncated, updatedAt: new Date().toISOString() });
const noop = () => {};
/** @param {import('../src/renderer/activity.js').Activity | null} value @param {Record<string, any>} [props] */
const render = (value, { stopResult = null, stopping = false } = {}) => renderToStaticMarkup(<ActivityPanel activity={value}
  stopResult={stopResult} stopping={stopping} visible onStopAll={noop} onStopTask={noop} onForceStop={noop} />);
const count = (/** @type {string} */ html, /** @type {RegExp} */ pattern) => html.match(pattern)?.length ?? 0;

test('a workflow is one card with its name, kind, status, elapsed time and tokens, and a Stop while it runs', () => {
  const html = render(activity([workflow({ workflowName: 'api-plan-review', description: 'Workflow api-plan-review', runId: 'wf-1-run', tokens: 1_200_000 })]));
  expect(count(html, /class="workflow-card"/g)).toBe(1);
  expect(html).toContain('api-plan-review');
  expect(html).toMatch(/Workflow · running · \d\d:\d\d · 1\.2M tokens/);
  expect(count(html, /<button[^>]*>Stop<\/button>/g)).toBe(1);
  // One task on the wire: no agent count, phase dots, Large badge, Stop run or agent rows.
  for (const absent of ['Stop run', 'agent', 'Large', 'data-status=', 'task-row', '<details']) expect(html).not.toContain(absent);
});

test('a finished workflow card falls back to its description, freezes its elapsed time, and offers no Stop', () => {
  const html = render(activity([workflow({ description: 'Workflow review', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:09:41.000Z' })]));
  expect(html).toContain('Workflow review');
  expect(html).toContain('Workflow · done · 09:41<');
  expect(html).not.toMatch(/<button[^>]*>Stop<\/button>/);
  expect(html).not.toContain('tokens');
  expect(html).toContain('Nothing running');
});

test('workflow cards come running first and newest first, before the tasks', () => {
  const html = render(activity([
    workflow({ workflowName: 'finished', status: 'completed', startedAt: '2026-10-24T00:00:05.000Z', endedAt: '2026-10-24T00:00:09.000Z' }),
    workflow({ workflowName: 'older', startedAt: '2026-10-24T00:00:01.000Z' }),
    task({ description: 'A command', taskType: 'local_bash' }),
    workflow({ workflowName: 'newer', startedAt: '2026-10-24T00:00:03.000Z' }),
  ]));
  const at = (/** @type {string} */ text) => html.indexOf(`>${text}<`);
  expect([at('newer'), at('older'), at('finished'), at('A command')].every((index, i, all) => index >= 0 && (i === 0 || index > all[i - 1]))).toBe(true);
});

test('a standalone running task is a row with its kind, phase, status, and a Stop; a finished one reads done', () => {
  const html = render(activity([
    task({ description: 'Watch the build', subagentType: 'general-purpose', phase: 'Build', tokens: 950 }),
    task({ description: 'Run the tests', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:02:05.000Z' }),
    task({ description: 'Lint', status: 'stopped' }),
    task({ description: 'Deploy', status: 'failed' }),
    task({ description: 'Sleep for 60 seconds', runId: '0mvll0x40-1842e72b', taskType: 'local_bash', status: 'completed' }),
    task({ description: 'Explore the repo', taskType: 'local_agent', status: 'completed' }),
  ]));
  expect(count(html, /task-row/g)).toBe(6);
  expect(html).not.toContain('workflow-card');
  expect(html).toContain('Watch the build');
  expect(html).toMatch(/Agent · Build · running · \d\d:\d\d · 950 tokens/);
  expect(html).toMatch(/Command · done · \d\d:\d\d</);
  expect(html).toMatch(/Agent · done · \d\d:\d\d</);
  expect(count(html, /<button[^>]*>Stop<\/button>/g)).toBe(1);
  expect(html).toContain('Run the tests');
  expect(html).toContain('Task · done · 02:05<');
  expect(html).toMatch(/Task · stopped · \d\d:\d\d</);
  expect(html).toMatch(/Task · failed · \d\d:\d\d</);
  expect(html).not.toContain(' 0 tokens');
});

test('the heading offers Stop background work while anything runs, and says Nothing running otherwise', () => {
  const busy = render(activity([task()]));
  expect(busy).toContain('Activity');
  expect(busy).toMatch(/<button[^>]*>Stop background work<\/button>/);
  expect(busy).not.toContain('Nothing running');
  const idle = render(null);
  expect(idle).toContain('Activity');
  expect(idle).toContain('Nothing running');
  expect(idle).not.toContain('Stop background work');
});

test('while the stop is pending its button reads Stopping… and is disabled, as the activity line’s does', () => {
  const html = render(activity([task()]), { stopping: true });
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
  expect(html).not.toContain('Stop background work');
});

test('a stop that left its tasks running offers Force stop; none before a stop, after a full one, or over later work', () => {
  const stuck = [task(), task()];
  const taskIds = stuck.map(item => item.taskId);
  const escalated = render(activity(stuck), { stopResult: { requested: 2, stopped: 0, escalated: true, taskIds } });
  expect(escalated).toContain('Some tasks did not stop');
  expect(escalated).toMatch(/<button[^>]*>Force stop<\/button>/);
  expect(render(activity(stuck), { stopResult: { requested: 2, stopped: 1, escalated: false, taskIds } })).toContain('Force stop');
  expect(render(activity(stuck))).not.toContain('Force stop');
  expect(render(activity(stuck), { stopResult: { requested: 2, stopped: 2, escalated: false, taskIds } })).not.toContain('Force stop');
  // The stop's tasks ended (the engine records a closed process's tasks as failed); later work is not what it was about.
  const later = activity([...stuck.map(item => ({ ...item, status: /** @type {const} */ ('failed'), endedAt: new Date().toISOString() })), task()]);
  expect(render(later, { stopResult: { requested: 2, stopped: 0, escalated: true, taskIds } })).not.toContain('Force stop');
});

test('the force-stop confirmation says what closing the process ends', () => {
  const html = renderToStaticMarkup(<ForceStopDialog onConfirm={noop} onClose={noop} />);
  expect(html).toContain('Close Claude&#x27;s process?');
  expect(html).toContain('Its background work, and any answer in progress, end with the process. The conversation continues with a fresh process on your next message.');
  expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
  expect(html).toMatch(/<button[^>]*>Close process<\/button>/);
});

test('a snapshot the engine cut short says older finished tasks are not listed', () => {
  expect(render(activity([task()], true))).toContain('Older finished tasks are not listed');
  expect(render(activity([task()]))).not.toContain('Older finished tasks are not listed');
});

test('two hundred tasks, sixteen of them workflows, render in one static pass', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => index < 16 ? workflow({ workflowName: `flow ${index}`, tokens: 1000 }) : task({ runId: `run_${index}`, phase: `Phase ${index % 3}`, tokens: 1000, status: index % 5 ? 'running' : 'completed' }));
  const html = render(activity(tasks));
  expect(count(html, /class="workflow-card"/g)).toBe(16);
  expect(html.match(/task-row/g).length).toBe(184);
});
