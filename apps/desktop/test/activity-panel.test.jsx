import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel, ForceStopDialog } from '../src/renderer/components/activity-panel.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', runId = null, phase = null, subagentType = null, description = 'A task', tokens = null, startedAt = new Date().toISOString(), endedAt = status === 'running' ? null : new Date().toISOString() } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId: null, description, subagentType, phase, backgrounded: true, status,
  startedAt, endedAt, usage: { totalTokens: tokens, toolUses: null, durationMs: null },
});
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks, truncated = false) => ({ state: 'background', tasks, truncated, updatedAt: new Date().toISOString() });
const noop = () => {};
/** @param {import('../src/renderer/activity.js').Activity | null} value @param {Record<string, any>} [props] */
const render = (value, { stopResult = null, workflowNames = new Map(), stopping = false } = {}) => renderToStaticMarkup(<ActivityPanel activity={value} workflowNames={workflowNames}
  stopResult={stopResult} stopping={stopping} visible onStopAll={noop} onStopTask={noop} onStopRun={noop} onForceStop={noop} />);
const count = (/** @type {string} */ html, /** @type {RegExp} */ pattern) => html.match(pattern)?.length ?? 0;

test('a workflow run of three agents in two phases is one card with its agents behind a disclosure', () => {
  const run = [
    task({ runId: 'run_1', phase: 'Plan', status: 'completed', tokens: 4000 }),
    task({ runId: 'run_1', phase: 'Verify', tokens: 8400 }),
    task({ runId: 'run_1', phase: 'Verify' }),
  ];
  const html = render(activity(run), { workflowNames: new Map([['run_1', 'api-plan-review']]) });
  expect(count(html, /class="workflow-card"/g)).toBe(1);
  expect(html).toContain('api-plan-review');
  expect(html).toMatch(/Workflow · 3 agents · \d\d:\d\d · 12k tokens/);
  expect(count(html, /data-status="/g)).toBe(2);
  expect(html).toContain('data-status="done"');
  expect(html).toContain('data-status="running"');
  expect(html).toMatch(/<button[^>]*>Stop run<\/button>/);
  expect(html).not.toContain('Large');
  expect(html).toMatch(/<details[^>]*>.*task-row.*<\/details>/s);
  expect(count(html, /task-row/g)).toBe(3);
});

test('a card falls back to its first task, badges a large run, and offers no Stop run once it ended', () => {
  const agents = Array.from({ length: 26 }, () => task({ runId: 'run_2', description: 'Check a file', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:09:41.000Z' }));
  const html = render(activity(agents));
  expect(html).toContain('Check a file');
  expect(html).toContain('Workflow · 26 agents · 09:41<');
  expect(html).toContain('Large');
  expect(html).not.toContain('Stop run');
  expect(html).not.toContain('tokens');
  expect(html).toContain('Nothing running');
});

test('a standalone running task is a row with its kind, phase, status, and a Stop; a finished one reads done', () => {
  const html = render(activity([
    task({ description: 'Watch the build', subagentType: 'general-purpose', phase: 'Build', tokens: 950 }),
    task({ description: 'Run the tests', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:02:05.000Z' }),
    task({ description: 'Lint', status: 'stopped' }),
    task({ description: 'Deploy', status: 'failed' }),
  ]));
  expect(count(html, /task-row/g)).toBe(4);
  expect(html).toContain('Watch the build');
  expect(html).toMatch(/Agent · Build · running · \d\d:\d\d · 950 tokens/);
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

test('two hundred tasks across sixteen runs render in one static pass', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => task({ runId: `run_${index % 16}`, phase: `Phase ${index % 3}`, tokens: 1000, status: index % 5 ? 'running' : 'completed' }));
  const html = render(activity(tasks));
  expect(count(html, /class="workflow-card"/g)).toBe(16);
  expect(html.match(/task-row/g).length).toBe(200);
});
