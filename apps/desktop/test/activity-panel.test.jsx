import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearFinished } from '../src/renderer/activity.js';
import { ActivityPanel, ForceStopDialog } from '../src/renderer/components/activity-panel.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', runId = null, phase = null, subagentType = null, taskType = null, workflowName = null, description = 'A task', tokens = null, toolUses = null, startedAt = new Date().toISOString(), endedAt = status === 'running' ? null : new Date().toISOString(), workflow = undefined } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId: null, description, subagentType, taskType, workflowName, phase, backgrounded: true, status,
  startedAt, endedAt, usage: { totalTokens: tokens, toolUses, durationMs: null }, workflow,
});
/** A workflow as Claude Code 2.1.304 reports one: one task of type local_workflow. @param {Record<string, any>} [options] */
const workflow = (options = {}) => task({ taskType: 'local_workflow', ...options });
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks, truncated = false) => ({ state: 'background', tasks, truncated, updatedAt: new Date().toISOString() });
const noop = () => {};
/** @param {import('../src/renderer/activity.js').Activity | null} value @param {Record<string, any>} [props] */
const render = (value, { stopResult = null, stopping = false, cleared = {} } = {}) => renderToStaticMarkup(<ActivityPanel activity={value}
  stopResult={stopResult} stopping={stopping} visible cleared={cleared} onStopAll={noop} onStopTask={noop} onForceStop={noop} onClear={noop} />);
const count = (/** @type {string} */ html, /** @type {RegExp} */ pattern) => html.match(pattern)?.length ?? 0;
/** The statuses of a phase's squares, in order, found by its title. */
const squares = (/** @type {string} */ html, /** @type {string} */ title) => {
  const block = html.match(new RegExp(`<div class="phase-head"><span>${title}</span><span>[^<]*</span></div>(<div class="phase-squares"[^>]*>.*?</div>)?`))?.[1] ?? '';
  return [...block.matchAll(/data-status="(\w+)"/g)].map(match => match[1]);
};
/** What a phase's squares say in words, found by its title: their text alternative. */
const squaresLabel = (/** @type {string} */ html, /** @type {string} */ title) => html.match(new RegExp(`<div class="phase-head"><span>${title}</span><span>[^<]*</span></div><div class="phase-squares" role="img" aria-label="([^"]*)">`))?.[1] ?? null;
/** The part of the panel past its heading (whose `Nothing running` would otherwise count). */
const card = (/** @type {string} */ html) => html.slice(html.indexOf('<li class="workflow-card"'));

test('a workflow is one card: its name and elapsed time with a Stop while it runs, then Workflow and its status, then its tokens', () => {
  const html = render(activity([workflow({ workflowName: 'api-plan-review', description: 'Workflow api-plan-review', runId: 'wf-1-run', tokens: 1_200_000 })]));
  expect(count(html, /class="workflow-card"/g)).toBe(1);
  expect(html).toMatch(/<li class="workflow-card" data-state="running"><div class="item-head"><span class="workflow-title" title="api-plan-review">api-plan-review<\/span><span class="activity-elapsed">\d\d:\d\d<\/span><button type="button">Stop<\/button><\/div>/);
  expect(html).toContain('<div class="card-meta"><span>Workflow</span><span>Running</span></div>');
  expect(html).toContain('<div class="card-meta"><span>1.2M tokens</span></div>');
  expect(count(html, /<button[^>]*>Stop<\/button>/g)).toBe(1);
  // Claude Code describes a workflow's task `Workflow <name>`, which no paragraph repeats; and with no progress report of
  // its agents yet: no agent count, phases, squares or Large badge.
  for (const absent of ['workflow-description', 'Stop run', 'agent', 'Large', 'data-status=', 'Phases', 'task-row', 'finished-tasks']) expect(html).not.toContain(absent);
});

/** A workflow's summary as the engine keeps it from Claude's progress report, its totals summed from its phases. */
const summary = (/** @type {{ title: string, agents: number, done: number, running: number, failed: number }[]} */ phases, current = null) => ({
  phases, current,
  agents: phases.reduce((sum, item) => ({ total: sum.total + item.agents, running: sum.running + item.running, done: sum.done + item.done, failed: sum.failed + item.failed }), { total: 0, running: 0, done: 0, failed: 0 }),
});

test('a finished workflow card reads as Claude Code’s: Workflow Completed, its agents and tokens, its description, and its phases with a square per agent', () => {
  const html = render(activity([workflow({
    workflowName: 'kb-as-is-analysis', description: 'As-is analysis of the old knowledge base: five readers and one synthesis', status: 'completed', tokens: 1_300_000,
    startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:17:18.000Z',
    workflow: summary([{ title: 'Read', agents: 5, done: 5, running: 0, failed: 0 }, { title: 'Synthesize', agents: 1, done: 1, running: 0, failed: 0 }], 'Synthesize: synthesize:1'),
  })]));
  expect(html).toContain('<span class="workflow-title" title="kb-as-is-analysis">kb-as-is-analysis</span><span class="activity-elapsed">17:18</span></div>');
  expect(html).toContain('<div class="card-meta"><span>Workflow</span><span>Completed</span></div>');
  expect(html).toContain('<div class="card-meta"><span>6 agents</span><span>1.3M tokens</span></div>');
  expect(html).toContain('<p class="workflow-description">As-is analysis of the old knowledge base: five readers and one synthesis</p>');
  expect(html).toContain('<span class="phases-label">Phases</span>');
  expect(html).toContain('<div class="phase-head"><span>Read</span><span>5/5</span></div>');
  expect(squares(html, 'Read')).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(html).toContain('<div class="phase-head"><span>Synthesize</span><span>1/1</span></div>');
  expect(squares(html, 'Synthesize')).toEqual(['done']);
  expect(squaresLabel(html, 'Read')).toBe('5 done');
  expect(squaresLabel(html, 'Synthesize')).toBe('1 done');
  expect(html).not.toMatch(/<button[^>]*>Stop<\/button>/);
  expect(html).not.toContain('Synthesize: synthesize:1'); // the agent the last report named, only while the workflow runs
});

test('a running workflow’s phases carry the agent the last report named, and each phase a square per agent', () => {
  const html = render(activity([workflow({ workflowName: 'demo', tokens: 20_388, workflow: summary([{ title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }], 'Say: say:1') })]));
  expect(html).toContain('<div class="card-meta"><span>Workflow</span><span>Running</span></div>');
  expect(html).toContain('<div class="card-meta"><span>2 agents</span><span>20k tokens</span></div>');
  expect(html).toContain('<div class="workflow-phases" title="Say: say:1">');
  expect(html).toContain('<div class="workflow-phase" data-state="running"><div class="phase-head"><span>Say</span><span>1/2</span></div>');
  expect(squares(html, 'Say')).toEqual(['done', 'running']);
  expect(squaresLabel(html, 'Say')).toBe('1 done, 1 running');
  expect(html).not.toContain('Large');
});

test('a phase’s squares come done, running, failed, then pending, and a phase of no agents has none', () => {
  const html = render(activity([workflow({ workflowName: 'release', workflow: summary([
    { title: 'Plan', agents: 1, done: 1, running: 0, failed: 0 },
    { title: 'Build', agents: 5, done: 1, running: 1, failed: 1 },
    { title: 'Ship', agents: 0, done: 0, running: 0, failed: 0 },
  ]) })]));
  expect(html).toContain('<div class="card-meta"><span>6 agents</span></div>');
  expect(squares(html, 'Plan')).toEqual(['done']);
  expect(squares(html, 'Build')).toEqual(['done', 'running', 'failed', 'pending', 'pending']);
  expect(squaresLabel(html, 'Build')).toBe('1 done, 1 running, 1 failed, 2 pending'); // in words, a status none has left out
  expect(html).toContain('<div class="workflow-phase" data-state="failed"><div class="phase-head"><span>Build</span><span>1/5</span></div>');
  expect(html).toContain('<div class="workflow-phase" data-state="pending"><div class="phase-head"><span>Ship</span><span>0/0</span></div></div>');
});

test('a workflow that ended gives the squares it left running its own end word, and names no current agent', () => {
  const ended = (/** @type {'stopped' | 'failed'} */ status) => card(render(activity([workflow({ workflowName: 'demo', status, tokens: 20_388, workflow: summary([
    { title: 'Say', agents: 2, done: 1, running: 1, failed: 0 },
    { title: 'Check', agents: 1, done: 0, running: 0, failed: 0 },
  ], 'Say: say:2') })])));
  const stopped = ended('stopped');
  expect(stopped).toContain('<div class="card-meta"><span>Workflow</span><span>Stopped</span></div>');
  expect(squares(stopped, 'Say')).toEqual(['done', 'stopped']);
  expect(squares(stopped, 'Check')).toEqual(['pending']);
  expect(squaresLabel(stopped, 'Say')).toBe('1 done, 1 stopped');
  expect(squaresLabel(stopped, 'Check')).toBe('1 pending');
  expect(stopped).not.toMatch(/running/i);
  expect(stopped).not.toContain('Say: say:2');
  const failed = ended('failed');
  expect(failed).toContain('<div class="card-meta"><span>Workflow</span><span>Failed</span></div>');
  expect(squares(failed, 'Say')).toEqual(['done', 'failed']);
  expect(squaresLabel(failed, 'Say')).toBe('1 done, 1 failed');
  expect(failed).not.toMatch(/running/i);
  expect(failed).not.toContain('Say: say:2');
});

test('a workflow whose agents have reported no spend yet, and a task that reported 0, show no token count', () => {
  const html = render(activity([
    workflow({ workflowName: 'demo', tokens: 0, workflow: summary([{ title: 'Say', agents: 2, done: 0, running: 2, failed: 0 }], 'Say: say:1') }),
    task({ description: 'A command', taskType: 'local_bash', tokens: 0, toolUses: 0 }),
  ]));
  expect(html).toContain('<div class="card-meta"><span>2 agents</span></div>');
  expect(html).toContain('<div class="activity-task-meta">Command · Running</div>');
  expect(html).not.toMatch(/\b0 tokens|tool use/);
});

test('a workflow of more than 25 agents is badged Large beside its status; one agent reads in the singular', () => {
  const fanOut = (/** @type {number} */ agents) => render(activity([workflow({ workflowName: 'fan-out', workflow: summary([{ title: 'Fan out', agents, done: 0, running: agents, failed: 0 }]) })]));
  expect(fanOut(26)).toContain('<div class="card-meta"><span>Workflow</span><span>Running</span><span class="plan-mark">Large</span></div>');
  expect(fanOut(26)).toContain('<span>26 agents</span>');
  expect(squares(fanOut(26), 'Fan out')).toHaveLength(26);
  expect(fanOut(25)).not.toContain('Large');
  expect(fanOut(1)).toContain('<span>1 agent</span>');
});

test('a finished workflow card falls back to its description, which it does not repeat, freezes its elapsed time, and offers no Stop', () => {
  const html = render(activity([workflow({ description: 'Workflow review', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:09:41.000Z' })]));
  expect(html).toContain('<span class="workflow-title" title="Workflow review">Workflow review</span><span class="activity-elapsed">09:41</span></div>');
  expect(html).toContain('<div class="card-meta"><span>Workflow</span><span>Completed</span></div>');
  expect(html).not.toContain('workflow-description');
  expect(html).not.toMatch(/<button[^>]*>Stop<\/button>/);
  expect(html).not.toContain('tokens');
});

test('the running tasks come first, cards and rows newest first; the finished ones under Finished N, newest first', () => {
  const html = render(activity([
    workflow({ workflowName: 'finished', status: 'completed', startedAt: '2026-10-24T00:00:05.000Z', endedAt: '2026-10-24T00:00:09.000Z' }),
    workflow({ workflowName: 'older', startedAt: '2026-10-24T00:00:01.000Z' }),
    task({ description: 'A command', taskType: 'local_bash', startedAt: '2026-10-24T00:00:02.000Z' }),
    workflow({ workflowName: 'newer', startedAt: '2026-10-24T00:00:03.000Z' }),
    task({ description: 'Lint', status: 'stopped', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:00:04.000Z' }),
  ]));
  const at = (/** @type {string} */ text) => html.indexOf(`>${text}<`);
  const section = html.search(/<details open="" class="finished-tasks"><summary><span>Finished 2<\/span><svg[^>]*class="icon activity-disclosure"/);
  expect(section).toBeGreaterThan(0);
  expect([at('newer'), at('A command'), at('older'), section, at('finished'), at('Lint')].every((index, i, all) => index >= 0 && (i === 0 || index > all[i - 1]))).toBe(true);
  expect(count(html, /<ol class="activity-list">/g)).toBe(2);
});

test('nothing finished leaves the Finished section out', () => {
  const html = render(activity([task(), workflow({ workflowName: 'demo' })]));
  expect(html).not.toContain('finished-tasks');
  expect(html).not.toContain('Finished');
});

test('a task row says its description and elapsed time, a Stop while it runs, then its kind, status, tokens and tool uses', () => {
  const html = render(activity([
    task({ description: 'Sleep for 60 seconds', runId: '0mvll0x40-1842e72b', taskType: 'local_bash' }),
    task({ description: 'D20: drop the MFA keys from the wire', taskType: 'local_agent', status: 'completed', tokens: 137_500, toolUses: 6, startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:01:57.000Z' }),
    task({ description: 'Watch the build', subagentType: 'general-purpose', phase: 'Build', tokens: 950, toolUses: 1 }),
    task({ description: 'Lint', status: 'stopped', toolUses: 0 }),
    task({ description: 'Deploy', status: 'failed' }),
  ]));
  expect(count(html, /class="task-row"/g)).toBe(5);
  expect(html).not.toContain('workflow-card');
  expect(html).toMatch(/<li class="task-row" data-state="running"><div class="item-head"><span class="activity-task-name" title="Sleep for 60 seconds">Sleep for 60 seconds<\/span><span class="activity-elapsed">\d\d:\d\d<\/span><button type="button">Stop<\/button><\/div><div class="activity-task-meta">Command · Running<\/div><\/li>/);
  // formatTokens reads 137.5k as 138k, as the activity line does.
  expect(html).toContain('<span class="activity-elapsed">01:57</span></div><div class="activity-task-meta">Agent · Completed · 138k tokens · 6 tool uses</div>');
  expect(html).toContain('<div class="activity-task-meta">Agent · Running · 950 tokens · 1 tool use</div>');
  expect(html).toContain('<li class="task-row" data-state="stopped">');
  expect(html).toContain('<div class="activity-task-meta">Task · Stopped</div>');
  expect(html).toContain('<div class="activity-task-meta">Task · Failed</div>');
  expect(count(html, /<button[^>]*>Stop<\/button>/g)).toBe(2);
});

const CLEAR = '<button type="button" class="icon-button" aria-label="Clear finished" title="Clear finished"><svg';

test('the heading offers Stop background work while anything runs, Clear finished while anything finished is listed, and says Nothing running otherwise', () => {
  const busy = render(activity([task()]));
  expect(busy).toContain('<strong>Activity</strong>');
  expect(busy).toMatch(/<button[^>]*>Stop background work<\/button>/);
  expect(busy).not.toContain('Nothing running');
  expect(busy).not.toContain('Clear finished');
  const both = render(activity([task(), task({ status: 'completed' })]));
  expect(both).toMatch(/<button[^>]*>Stop background work<\/button><button type="button" class="icon-button" aria-label="Clear finished"/);
  const finished = render(activity([task({ status: 'completed' })]));
  expect(finished).toContain(CLEAR);
  expect(finished).not.toContain('Stop background work');
  expect(finished).not.toContain('Nothing running');
  for (const idle of [render(null), render(activity([]))]) {
    expect(idle).toContain('<strong>Activity</strong>');
    expect(idle).toContain('Nothing running');
    expect(idle).not.toContain('Stop background work');
    expect(idle).not.toContain('Clear finished');
  }
});

test('Clear finished hides the finished tasks it saw and leaves the running ones; one that ended since, or runs again, is listed', () => {
  const done = task({ description: 'Run the tests', status: 'completed' });
  const flow = workflow({ workflowName: 'review', status: 'stopped' });
  const running = task({ description: 'Watch the build' });
  const cleared = clearFinished(activity([done, flow, running]), {});
  const html = render(activity([done, flow, running]), { cleared });
  expect(html).toContain('>Watch the build<');
  expect(html).toMatch(/<button[^>]*>Stop background work<\/button>/);
  for (const absent of ['Run the tests', '>review<', 'finished-tasks', 'Clear finished', 'Nothing running']) expect(html).not.toContain(absent);
  const later = render(activity([done, flow, running, task({ description: 'Lint', status: 'failed' })]), { cleared });
  expect(later).toContain('<span>Finished 1</span>');
  expect(later).toContain('>Lint<');
  expect(later).toContain(CLEAR);
  expect(later).not.toContain('Run the tests');
  expect(render(activity([{ ...done, status: 'running', endedAt: null }, flow]), { cleared })).toContain('>Run the tests<');
  // Everything finished cleared and nothing running: the panel is empty again.
  expect(render(activity([done, flow]), { cleared })).toContain('Nothing running');
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
  expect(count(html, /class="task-row"/g)).toBe(184);
  expect(html).toContain('<span>Finished 36</span>');
});
