import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel, ForceStopDialog } from '../src/renderer/components/activity-panel.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', runId = null, phase = null, subagentType = null, taskType = null, workflowName = null, description = 'A task', tokens = null, startedAt = new Date().toISOString(), endedAt = status === 'running' ? null : new Date().toISOString(), workflow = undefined } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId: null, description, subagentType, taskType, workflowName, phase, backgrounded: true, status,
  startedAt, endedAt, usage: { totalTokens: tokens, toolUses: null, durationMs: null }, workflow,
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
  // No progress report of its agents yet: no agent count, phase dots, Large badge, Stop run or phase list.
  for (const absent of ['Stop run', 'agent', 'Large', 'data-status=', 'task-row', '<details']) expect(html).not.toContain(absent);
});

/** A workflow's summary as the engine keeps it from Claude's progress report, its totals summed from its phases. */
const summary = (/** @type {{ title: string, agents: number, done: number, running: number, failed: number }[]} */ phases, current = null) => ({
  phases, current,
  agents: phases.reduce((sum, item) => ({ total: sum.total + item.agents, running: sum.running + item.running, done: sum.done + item.done, failed: sum.failed + item.failed }), { total: 0, running: 0, done: 0, failed: 0 }),
});

test('a workflow whose progress reported its agents shows their count, a dot per phase, and its phases on request', () => {
  const html = render(activity([workflow({ workflowName: 'demo', tokens: 20_388, workflow: summary([{ title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }], 'Say: say:1') })]));
  expect(count(html, /class="workflow-card"/g)).toBe(1);
  expect(html).toMatch(/Workflow · running · 2 agents · \d\d:\d\d · 20k tokens/);
  expect(count(html, /class="status-dots"/g)).toBe(1);
  expect([...html.matchAll(/<span data-status="(\w+)"/g)].map(match => match[1])).toEqual(['running']);
  expect(html).toContain('<span class="status-dots" title="Say: say:1">'); // the agent the last report named, while it runs
  expect(html).toContain('<details');
  expect(html).toContain('>Phases<');
  expect(html).toContain('>Say · 1/2<');
  expect(html).not.toContain('Large');
});

test('each phase of a workflow has a dot of its status, in order, and a row in its list', () => {
  const html = render(activity([workflow({ workflowName: 'release', workflow: summary([
    { title: 'Plan', agents: 1, done: 1, running: 0, failed: 0 },
    { title: 'Build', agents: 2, done: 1, running: 1, failed: 0 },
    { title: 'Verify', agents: 2, done: 1, running: 0, failed: 1 },
    { title: 'Ship', agents: 0, done: 0, running: 0, failed: 0 },
  ]) })]));
  expect([...html.matchAll(/<span data-status="(\w+)"/g)].map(match => match[1])).toEqual(['done', 'running', 'failed', 'pending']);
  expect(html).toMatch(/Workflow · running · 5 agents · \d\d:\d\d</);
  for (const row of ['>Plan · 1/1<', '>Build · 1/2<', '>Verify · 1/2<', '>Ship · 0/0<']) expect(html).toContain(row);
});

test('a workflow that ended names a phase it left running by its own end word, in the dot and its tooltip, and no current agent', () => {
  const ended = (/** @type {'stopped' | 'failed'} */ status) => render(activity([workflow({ workflowName: 'demo', status, tokens: 20_388, workflow: summary([
    { title: 'Say', agents: 2, done: 1, running: 1, failed: 0 },
    { title: 'Check', agents: 0, done: 0, running: 0, failed: 0 },
  ], 'Say: say:2') })]));
  const card = (/** @type {string} */ html) => html.slice(html.indexOf('<section class="workflow-card"')); // past the heading's Nothing running
  const stopped = card(ended('stopped'));
  expect(stopped).toMatch(/Workflow · stopped · 2 agents · \d\d:\d\d · 20k tokens/);
  expect([...stopped.matchAll(/<span data-status="(\w+)"/g)].map(match => match[1])).toEqual(['stopped', 'pending']);
  expect(stopped).toContain('title="Say: stopped"');
  expect(stopped).not.toContain('running');
  expect(stopped).not.toContain('Say: say:2');
  const failed = card(ended('failed'));
  expect([...failed.matchAll(/<span data-status="(\w+)"/g)].map(match => match[1])).toEqual(['failed', 'pending']);
  expect(failed).toContain('title="Say: failed"');
  expect(failed).not.toContain('running');
  expect(failed).not.toContain('Say: say:2');
});

test('a workflow whose agents have reported no spend yet, and a task that reported 0, show no token count', () => {
  const html = render(activity([
    workflow({ workflowName: 'demo', tokens: 0, workflow: summary([{ title: 'Say', agents: 2, done: 0, running: 2, failed: 0 }], 'Say: say:1') }),
    task({ description: 'A command', taskType: 'local_bash', tokens: 0 }),
  ]));
  expect(html).toMatch(/Workflow · running · 2 agents · \d\d:\d\d</);
  expect(html).toMatch(/Command · running · \d\d:\d\d</);
  expect(html).not.toContain('0 tokens');
});

test('a workflow of more than 25 agents is badged Large; one agent reads in the singular', () => {
  const fanOut = (/** @type {number} */ agents) => render(activity([workflow({ workflowName: 'fan-out', workflow: summary([{ title: 'Fan out', agents, done: 0, running: agents, failed: 0 }]) })]));
  expect(fanOut(26)).toContain('>Large<');
  expect(fanOut(26)).toContain('26 agents');
  expect(fanOut(25)).not.toContain('Large');
  expect(fanOut(1)).toMatch(/Workflow · running · 1 agent · /);
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
