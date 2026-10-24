import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearFinished } from '../src/renderer/activity.js';
import { ActivityPanel, ForceStopDialog, TaskOutputView, TaskRow, WorkflowCard, agentKey, phaseKey } from '../src/renderer/components/activity-panel.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', runId = null, phase = null, subagentType = null, taskType = null, workflowName = null, description = 'A task', tokens = null, toolUses = null, startedAt = new Date().toISOString(), endedAt = status === 'running' ? null : new Date().toISOString(), workflow = undefined, ...detail } = {}) => ({
  taskId: `t${++ids}`, runId, toolUseId: null, description, subagentType, taskType, workflowName, phase, backgrounded: true, status,
  startedAt, endedAt, usage: { totalTokens: tokens, toolUses, durationMs: null }, workflow, ...detail,
});
/** A workflow as Claude Code 2.1.304 reports one: one task of type local_workflow. @param {Record<string, any>} [options] */
const workflow = (options = {}) => task({ taskType: 'local_workflow', ...options });
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks, truncated = false) => ({ state: 'background', tasks, truncated, updatedAt: new Date().toISOString() });
const noop = () => {};
/** @param {import('../src/renderer/activity.js').Activity | null} value @param {Record<string, any>} [props] */
const render = (value, { stopResult = null, stopping = false, cleared = {}, childTasks = undefined, delegations = undefined, mcpServers = undefined } = {}) => renderToStaticMarkup(<ActivityPanel activity={value}
  stopResult={stopResult} stopping={stopping} visible cleared={cleared} onStopAll={noop} onStopTask={noop} onForceStop={noop} onClear={noop}
  childTasks={childTasks} delegations={delegations} onOpenTask={noop} onStopChild={noop} mcpServers={mcpServers} loadTaskOutput={async () => ({ output: '', totalBytes: 0, truncated: false })} />);
/** The chevron that opens a task's output, as a pattern; `open` says whether it reads open. */
const outputToggle = (open = false) => `<button type="button" class="icon-button task-output-toggle" aria-label="Show output" aria-expanded="${open}" title="Output"><svg[^>]*class="icon activity-disclosure"[^>]*>.*?</svg></button>`;
const count = (/** @type {string} */ html, /** @type {RegExp} */ pattern) => html.match(pattern)?.length ?? 0;
/** The statuses of a phase's squares, in order, found by its title. */
const squares = (/** @type {string} */ html, /** @type {string} */ title) => {
  const block = html.match(new RegExp(`<div class="phase-head"><span>${title}</span><span>[^<]*</span></div>(<div class="phase-squares"[^>]*>.*?</div>)?`))?.[1] ?? '';
  return [...block.matchAll(/data-status="(\w+)"/g)].map(match => match[1]);
};
/** What a phase's squares say in words, found by its title: their text alternative. */
const squaresLabel = (/** @type {string} */ html, /** @type {string} */ title) => html.match(new RegExp(`<div class="phase-head"><span>${title}</span><span>[^<]*</span></div><div class="phase-squares" role="img" aria-label="([^"]*)">`))?.[1] ?? null;
/** A running task's stop control, as a pattern: a square icon button named after the task, holding the stop icon. */
const stopSquare = (/** @type {string} */ name) => `<button type="button" class="icon-button stop-task" aria-label="Stop ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" title="Stop"><svg[^>]*><path d="M6 6h12v12H6Z"></path></svg></button>`;
/** Every task's stop control in the markup. */
const STOP_SQUARES = /<button type="button" class="icon-button stop-task" aria-label="Stop [^"]*" title="Stop"><svg[^>]*><path d="M6 6h12v12H6Z"><\/path><\/svg><\/button>/g;
/** The part of the panel past its heading (whose `Nothing running` would otherwise count). */
const card = (/** @type {string} */ html) => html.slice(html.indexOf('<li class="workflow-card"'));

test('a workflow is one card: its name and elapsed time with a stop square while it runs, then Workflow and its status, then its tokens', () => {
  const html = render(activity([workflow({ workflowName: 'api-plan-review', description: 'Workflow api-plan-review', runId: 'wf-1-run', tokens: 1_200_000 })]));
  expect(count(html, /class="workflow-card"/g)).toBe(1);
  expect(html).toMatch(new RegExp(`<li class="workflow-card" data-state="running"><div class="item-head"><span class="workflow-title" title="api-plan-review">api-plan-review</span><span class="activity-elapsed">\\d\\d:\\d\\d</span>${outputToggle()}${stopSquare('api-plan-review')}</div>`));
  expect(html).toContain('<div class="card-meta"><span>Workflow</span><span>Running</span></div>');
  expect(html).toContain('<div class="card-meta"><span>1.2M tokens</span></div>');
  expect(count(html, STOP_SQUARES)).toBe(1);
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
  expect(html).toMatch(new RegExp(`<span class="workflow-title" title="kb-as-is-analysis">kb-as-is-analysis</span><span class="activity-elapsed">17:18</span>${outputToggle()}</div>`));
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
  expect(html).not.toContain('stop-task');
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

test('a finished workflow card falls back to its description, which it does not repeat, freezes its elapsed time, and offers no stop', () => {
  const html = render(activity([workflow({ description: 'Workflow review', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:09:41.000Z' })]));
  expect(html).toMatch(new RegExp(`<span class="workflow-title" title="Workflow review">Workflow review</span><span class="activity-elapsed">09:41</span>${outputToggle()}</div>`));
  expect(html).toContain('<div class="card-meta"><span>Workflow</span><span>Completed</span></div>');
  expect(html).not.toContain('workflow-description');
  expect(html).not.toContain('stop-task');
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

test('a task row says its description and elapsed time, a stop square while it runs, then its kind, status, tokens and tool uses', () => {
  const html = render(activity([
    task({ description: 'Sleep for 60 seconds', runId: '0mvll0x40-1842e72b', taskType: 'local_bash' }),
    task({ description: 'D20: drop the MFA keys from the wire', taskType: 'local_agent', status: 'completed', tokens: 137_500, toolUses: 6, startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:01:57.000Z' }),
    task({ description: 'Watch the build', subagentType: 'general-purpose', phase: 'Build', tokens: 950, toolUses: 1 }),
    task({ description: 'Lint', status: 'stopped', toolUses: 0 }),
    task({ description: 'Deploy', status: 'failed' }),
  ]));
  expect(count(html, /class="task-row"/g)).toBe(5);
  expect(html).not.toContain('workflow-card');
  expect(html).toMatch(new RegExp(`<li class="task-row" data-state="running"><div class="item-head"><span class="activity-task-name" title="Sleep for 60 seconds">Sleep for 60 seconds</span><span class="activity-elapsed">\\d\\d:\\d\\d</span>${outputToggle()}${stopSquare('Sleep for 60 seconds')}</div><div class="activity-task-meta">Command · Running</div></li>`));
  // formatTokens reads 137.5k as 138k, as the activity line does.
  expect(html).toMatch(new RegExp(`<span class="activity-elapsed">01:57</span>${outputToggle()}</div><div class="activity-task-meta">Agent · Completed · 138k tokens · 6 tool uses</div>`));
  expect(html).toContain('<div class="activity-task-meta">Agent · Running · 950 tokens · 1 tool use</div>');
  expect(html).toContain('<li class="task-row" data-state="stopped">');
  expect(html).toContain('<div class="activity-task-meta">Task · Stopped</div>');
  expect(html).toContain('<div class="activity-task-meta">Task · Failed</div>');
  expect(count(html, STOP_SQUARES)).toBe(2);
});

test('a running task stops by a square at the top right of its row or card, named after the task; a finished one has none', () => {
  const html = render(activity([
    task({ description: 'Run the checks', taskType: 'local_bash', startedAt: '2026-10-24T00:00:02.000Z' }),
    workflow({ workflowName: 'review-changes', description: 'Workflow review-changes', startedAt: '2026-10-24T00:00:01.000Z' }),
    task({ description: 'Lint', status: 'completed', startedAt: '2026-10-24T00:00:00.000Z' }),
    workflow({ workflowName: 'kb-check', status: 'stopped', startedAt: '2026-10-24T00:00:00.000Z' }),
  ]));
  // The square is the head's last child, after the elapsed time: the row's description, the card's workflow name.
  expect(html).toMatch(new RegExp(`<span class="activity-elapsed">[\\d:]+</span>${outputToggle()}${stopSquare('Run the checks')}</div><div class="activity-task-meta">`));
  expect(html).toMatch(new RegExp(`<span class="activity-elapsed">[\\d:]+</span>${outputToggle()}${stopSquare('review-changes')}</div><div class="card-meta">`));
  expect(count(html, STOP_SQUARES)).toBe(2);
  // Under Finished: no stop on the row or the card.
  const finished = html.slice(html.indexOf('class="finished-tasks"'));
  expect(finished).toContain('>Lint<');
  expect(finished).toContain('>kb-check<');
  expect(finished.replace(/<summary>.*?<\/summary>/, '')).not.toContain('stop-task'); // its output chevron is its only button
  // The heading's Stop background work stays a text button.
  expect(html).toMatch(/<button type="button">Stop background work<\/button>/);
});

test('a running task shows what it does now: its progress line under its status, else the tool it last used on the status line', () => {
  const html = render(activity([
    task({ description: 'Run 75s sleep command', taskType: 'local_agent', tokens: 22_304, toolUses: 1, progress: 'Running Sleep 75 seconds then print ok', lastTool: 'Bash', startedAt: '2026-10-24T00:00:02.000Z' }),
    task({ description: 'Watch the build', taskType: 'local_bash', lastTool: 'Bash', startedAt: '2026-10-24T00:00:01.000Z' }),
    task({ description: 'An older engine', startedAt: '2026-10-24T00:00:00.000Z' }),
  ]));
  expect(html).toContain('<div class="activity-task-meta">Agent · Running · 22k tokens · 1 tool use</div><div class="activity-now" title="Running Sleep 75 seconds then print ok">Running Sleep 75 seconds then print ok</div></li>');
  expect(html).toContain('<div class="activity-task-meta">Command · Running · Bash</div></li>');
  expect(html).toContain('<div class="activity-task-meta">Task · Running</div></li>');
  expect(count(html, /class="activity-now"/g)).toBe(1);
  for (const absent of ['activity-summary', 'activity-output', 'Output:']) expect(html).not.toContain(absent);
});

test('a finished task shows how it ended: its summary when that says more than its description, and its output file by name', () => {
  const html = render(activity([
    task({ description: 'Run the tests', taskType: 'local_bash', status: 'completed', summary: '214 passed, 0 failed', outputFile: '/private/tmp/claude-501/s/tasks/b7x.output', progress: 'Running bun test', lastTool: 'Bash', startedAt: '2026-10-24T00:00:02.000Z' }),
    task({ description: 'Run 75s sleep command', taskType: 'local_agent', status: 'stopped', summary: 'Run 75s sleep command', outputFile: '', startedAt: '2026-10-24T00:00:01.000Z' }),
  ]));
  expect(html).toContain('<div class="activity-task-meta">Command · Completed</div><div class="activity-summary" title="214 passed, 0 failed">214 passed, 0 failed</div><div class="activity-output" title="/private/tmp/claude-501/s/tasks/b7x.output">Output: b7x.output</div></li>');
  // A summary that repeats the description, and an output file Claude left empty, add nothing.
  expect(html).toContain('<div class="activity-task-meta">Agent · Stopped</div></li>');
  for (const absent of ['activity-now', 'Running bun test', '· Bash']) expect(html).not.toContain(absent);
});

test('a task started by a listed task is drawn under it with ↳, one level deep; one whose parent is not listed stands at the top', () => {
  const agent = task({ description: 'Run the checks', taskType: 'local_agent', spawnDepth: 1, startedAt: '2026-10-24T00:00:01.000Z' });
  const command = task({ description: 'Run the checks command', taskType: 'local_bash', parentTaskId: agent.taskId, startedAt: '2026-10-24T00:00:02.000Z' });
  const deeper = task({ description: 'A command of the command', taskType: 'local_bash', parentTaskId: command.taskId, startedAt: '2026-10-24T00:00:03.000Z' });
  const orphan = task({ description: 'Left by a finished agent', taskType: 'local_bash', parentTaskId: 'gone', startedAt: '2026-10-24T00:00:04.000Z' });
  const html = render(activity([agent, command, deeper, orphan]));
  const at = (/** @type {string} */ text) => html.indexOf(`>${text}<`);
  expect([at('Left by a finished agent'), at('Run the checks'), at('A command of the command'), at('Run the checks command')].every((index, i, all) => index >= 0 && (i === 0 || index > all[i - 1]))).toBe(true);
  expect(html).toContain('<li class="task-row" data-state="running" data-nested=""><div class="item-head"><span class="activity-task-name" title="Run the checks command"><span class="activity-nest" aria-hidden="true">↳ </span>Run the checks command</span>');
  expect(html).toContain('<li class="task-row" data-state="running" data-nested=""><div class="item-head"><span class="activity-task-name" title="A command of the command"><span class="activity-nest" aria-hidden="true">↳ </span>A command of the command</span>');
  expect(html).toContain('<li class="task-row" data-state="running"><div class="item-head"><span class="activity-task-name" title="Run the checks">Run the checks</span>');
  expect(html).toContain('<li class="task-row" data-state="running"><div class="item-head"><span class="activity-task-name" title="Left by a finished agent">Left by a finished agent</span>');
  expect(count(html, /class="activity-nest"/g)).toBe(2);
  // A parent in the other list does not hold its child: the command that finished stands at the top of Finished.
  const split = render(activity([agent, { ...command, status: 'completed', endedAt: new Date().toISOString() }]));
  expect(split).not.toContain('activity-nest');
});

/** A workflow agent as the engine lists it. @param {Record<string, any>} [options] */
const agentOf = ({ label = 'say:1', phase = 'Say', phaseIndex = 1, state = 'running', model = 'claude-fable-5-1', tokens = null, toolCalls = null, durationMs = null, resultPreview = null } = {}) => ({ label, phase, phaseIndex, state, model, tokens, toolCalls, durationMs, resultPreview });
/** A workflow summary carrying its agent list, its phases numbered from 1 as the engine numbers them. */
const listed = (/** @type {ReturnType<typeof summary>} */ value, /** @type {ReturnType<typeof agentOf>[]} */ list) => ({ ...value, phases: value.phases.map((item, i) => ({ ...item, index: i + 1 })), agents: { ...value.agents, list } });
/** A workflow card alone, with the phases of `open` (their positions) open, and the agents of `expanded` ([phase, agent]) expanded. */
const renderCard = (/** @type {import('../src/renderer/activity.js').TaskRecord} */ item, /** @type {number[]} */ open = [], /** @type {[number, number][]} */ expanded = []) => renderToStaticMarkup(<ol>
  <WorkflowCard task={item} nested={false} now={Date.now()} onStopTask={noop} openPhases={new Set([...open.map(index => phaseKey(item.taskId, index)), ...expanded.map(([index, at]) => agentKey(item.taskId, index, at))])} onPhaseToggle={noop} />
</ol>);

test('each phase of a workflow whose agents are listed has a chevron, and lists nothing until it is opened', () => {
  const flow = workflow({ workflowName: 'demo', tokens: 20_388, workflow: listed(summary([{ title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }, { title: 'Check', agents: 0, done: 0, running: 0, failed: 0 }], 'Say: say:2'), [
    agentOf({ label: 'say:1', state: 'done', tokens: 20_388, toolCalls: 0, durationMs: 3428, resultPreview: 'agent 1 ok' }),
    agentOf({ label: 'say:2', tokens: 0 }),
  ]) });
  const closed = render(activity([flow]));
  expect(closed).toMatch(/<details class="workflow-phase" data-state="running"><summary><div class="phase-head"><span class="phase-title"><span>Say<\/span><svg[^>]*class="icon activity-disclosure"[^>]*>.*?<\/svg><\/span><span>1\/2<\/span><\/div><div class="phase-squares" role="img" aria-label="1 done, 1 running">.*?<\/div><\/summary><\/details>/);
  for (const absent of ['phase-agents', 'role="table"', 'agent 1 ok']) expect(closed).not.toContain(absent);
  // A phase none of whose agents is listed has nothing to open: no chevron.
  expect(closed).toContain('<div class="workflow-phase" data-state="pending"><div class="phase-head"><span>Check</span><span>0/0</span></div></div>');
  expect(count(closed, /<details class="workflow-phase"/g)).toBe(1);
  // Opened, it is a table: a header row once (Agent, Model, Tokens, Time), then a row per agent with a status square
  // (its state in words for assistive technology, and in the row's tooltip, never as a word in the row) and the agent's
  // result preview as a last cell of its row, set on a line of its own by the stylesheet, only when there is one.
  const open = renderCard(flow, [0]);
  expect(open).toMatch(/<details class="workflow-phase" data-state="running" open="">/);
  expect(open).toContain('<div class="phase-agents" role="table" aria-label="Say agents"><div class="phase-agents-head" role="row"><span role="columnheader">Agent</span><span role="columnheader">Model</span><span role="columnheader" class="num">Tokens</span><span role="columnheader" class="num">Time</span></div>');
  expect(open).toContain('<div class="phase-agent" role="row" data-state="done" title="say:1 · Fable 5.1 · 20k tokens · 00:03 · Done"><span role="cell" class="phase-agent-label"><button type="button" class="agent-toggle" aria-expanded="false"><span class="agent-square" role="img" aria-label="Done" data-status="done"></span>say:1</button></span><span role="cell">Fable 5.1</span><span role="cell" class="num">20k</span><span role="cell" class="num">00:03</span><span role="cell" class="phase-agent-result" title="agent 1 ok">agent 1 ok</span></div>');
  // An agent that reported no spend yet, and no duration or result: blank tokens and time, no 0, no preview.
  expect(open).toContain('<div class="phase-agent" role="row" data-state="running" title="say:2 · Fable 5.1 · Running"><span role="cell" class="phase-agent-label"><span class="agent-square" role="img" aria-label="Running" data-status="running"></span>say:2</span><span role="cell">Fable 5.1</span><span role="cell" class="num"></span><span role="cell" class="num"></span></div></div></details>');
  expect(count(open, /class="phase-agents-head"/g)).toBe(1);
  expect(count(open, /class="phase-agent-result"/g)).toBe(1);
  const table = open.slice(open.indexOf('class="phase-agents"'));
  expect(table).not.toMatch(/\b0 tokens|>0<|>Done<|>Running</);
});

test('two phases with one title each list their own agents, matched by index', () => {
  const flow = workflow({ workflowName: 'review', workflow: listed(summary([{ title: 'Review', agents: 1, done: 1, running: 0, failed: 0 }, { title: 'Review', agents: 1, done: 0, running: 1, failed: 0 }]), [
    agentOf({ label: 'first:1', phase: 'Review', phaseIndex: 1, state: 'done' }),
    agentOf({ label: 'second:1', phase: 'Review', phaseIndex: 2 }),
  ]) });
  const html = renderCard(flow, [0, 1]);
  const lists = [...html.matchAll(/<div class="phase-agents" role="table" aria-label="Review agents">(.*?)<\/details>/g)].map(match => [...match[1].matchAll(/<span role="cell" class="phase-agent-label"><span[^>]*><\/span>([^<]*)<\/span>/g)].map(label => label[1]));
  expect(lists).toEqual([['first:1'], ['second:1']]);
});

test('an agent still running on a workflow that ended reads with the workflow’s end word, as its square does', () => {
  const html = card(renderCard(workflow({ workflowName: 'demo', status: 'stopped', workflow: listed(summary([{ title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }]), [
    agentOf({ label: 'say:1', state: 'done', durationMs: 10_000, resultPreview: 'agent 1 ok' }),
    agentOf({ label: 'say:2', model: null }),
  ]) }), [0]));
  expect(html).toContain('<div class="phase-agent" role="row" data-state="done" title="say:1 · Fable 5.1 · 00:10 · Done">');
  // No model either: an empty model cell, so the columns still line up.
  expect(html).toContain('<div class="phase-agent" role="row" data-state="stopped" title="say:2 · Stopped"><span role="cell" class="phase-agent-label"><span class="agent-square" role="img" aria-label="Stopped" data-status="stopped"></span>say:2</span><span role="cell"></span><span role="cell" class="num"></span><span role="cell" class="num"></span></div>');
  expect(html).not.toMatch(/running/i);
});

test('a workflow from an engine before the agent list keeps its phases as they were, with no chevron', () => {
  const html = render(activity([workflow({ workflowName: 'demo', workflow: summary([{ title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }], 'Say: say:1') })]));
  expect(html).toContain('<div class="workflow-phase" data-state="running"><div class="phase-head"><span>Say</span><span>1/2</span></div><div class="phase-squares"');
  const phases = html.slice(html.indexOf('class="workflow-phases"'));
  for (const absent of ['<details class="workflow-phase"', 'activity-disclosure', 'phase-agents']) expect(phases).not.toContain(absent);
});

test('a finished workflow card shows its notification’s summary and its output file; a running one neither', () => {
  const done = card(render(activity([workflow({ workflowName: 'demo', description: 'Workflow demo', status: 'completed', summary: 'Dynamic workflow "Workflow demo" completed', outputFile: '/tmp/demo.output', progress: 'Say: say:2', lastTool: 'say:2' })])));
  // Set apart below the phases, in a group of their own.
  expect(done).toContain('<div class="card-meta"><span>Workflow</span><span>Completed</span></div><div class="workflow-ending"><div class="activity-summary" title="Dynamic workflow &quot;Workflow demo&quot; completed">Dynamic workflow &quot;Workflow demo&quot; completed</div><div class="activity-output" title="/tmp/demo.output">Output: demo.output</div></div></li>');
  const phased = card(render(activity([workflow({ workflowName: 'demo', status: 'completed', summary: 'All said', workflow: summary([{ title: 'Say', agents: 1, done: 1, running: 0, failed: 0 }]) })])));
  expect(phased.indexOf('class="workflow-ending"')).toBeGreaterThan(phased.indexOf('class="workflow-phases"'));
  const running = card(render(activity([workflow({ workflowName: 'demo', progress: 'Say: say:1', lastTool: 'say:1' })])));
  for (const absent of ['workflow-ending', 'activity-summary', 'activity-output', 'activity-now', 'say:1']) expect(running).not.toContain(absent);
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

test('an agent with a result preview opens it in full from its row, its label a button that says so; one without has nothing to open', () => {
  const preview = 'Mars, the fourth planet from the Sun, is a cold, dusty desert world with a thin atmosphere.\nIt has two moons.';
  const flow = workflow({ workflowName: 'planets', workflow: listed(summary([{ title: 'Write', agents: 2, done: 1, running: 1, failed: 0 }]), [
    agentOf({ label: 'sentence:Mars', phase: 'Write', state: 'done', resultPreview: preview }),
    agentOf({ label: 'sentence:Jupiter', phase: 'Write' }),
  ]) });
  const closed = renderCard(flow, [0]);
  expect(closed).toContain('<div class="phase-agent" role="row" data-state="done" title="sentence:Mars · Fable 5.1 · Done"><span role="cell" class="phase-agent-label"><button type="button" class="agent-toggle" aria-expanded="false">');
  const opened = renderCard(flow, [0], [[0, 0]]);
  expect(opened).toContain('<div class="phase-agent" role="row" data-state="done" data-expanded="" title="sentence:Mars · Fable 5.1 · Done"><span role="cell" class="phase-agent-label"><button type="button" class="agent-toggle" aria-expanded="true">');
  expect(opened).toContain(`<span role="cell" class="phase-agent-result" title="${preview}">${preview}</span>`);
  // The agent without a preview has no button and no expanded state, whichever agents are open.
  expect(opened).toContain('<div class="phase-agent" role="row" data-state="running" title="sentence:Jupiter · Fable 5.1 · Running"><span role="cell" class="phase-agent-label"><span class="agent-square"');
  expect(count(opened, /class="agent-toggle"/g)).toBe(1);
  expect(count(opened, /data-expanded/g)).toBe(1);
  // Agent keys are their own: opening an agent opens no phase.
  expect(renderCard(flow, [], [[0, 0]])).not.toContain('phase-agents');
});

test('a task Claude reports without a start is named by its summary, not repeated below, else by its kind and id; never a blank line', () => {
  const html = render(activity([
    task({ description: '', taskType: 'local_bash', status: 'stopped', summary: "Background shell command didn't finish before the previous session ended", outputFile: '/tmp/left.output', startedAt: '2026-10-24T00:00:02.000Z' }),
    task({ taskId: 'b8q2', description: '', taskType: 'local_bash', status: 'stopped', startedAt: '2026-10-24T00:00:01.000Z' }),
  ]));
  expect(html).toContain('<span class="activity-task-name" title="Background shell command didn&#x27;t finish before the previous session ended">Background shell command didn&#x27;t finish before the previous session ended</span>');
  expect(count(html, /Background shell command didn&#x27;t finish/g)).toBe(2); // its text and its tooltip, once
  expect(html).not.toContain('activity-summary');
  expect(html).toContain('Output: left.output'); // the output file still shows when the summary is the name
  expect(html).toContain('<span class="activity-task-name" title="Command b8q2">Command b8q2</span>');
  expect(html).not.toMatch(/<span class="activity-task-name" title="">/);
});

/** A child task as the board lists it. @param {Record<string, any>} [options] */
const childTask = ({ sessionId = `ses_${++ids}`, title = 'Write the parser tests', state = 'completed', updatedAt = '2026-10-24T00:01:00.000Z', attention = null, model = 'claude-opus-5-5' } = {}) => ({
  sessionId, title, attention, updatedAt, answerer: { displayName: 'Claude Code', model },
  run: state ? { id: `run_${sessionId}`, state, updatedAt, execution: { agentId: 'claude', model } } : null,
});
/** Its delegation row. */
const delegationOf = (/** @type {string} */ sessionId, /** @type {Record<string, any>} */ fields = {}) => ({ id: `del_${sessionId}`, sessionId, runId: `run_${sessionId}`, state: 'completed', activity: 'idle', done: true, partial: false, wakeReason: null, failure: null, createdAt: new Date(Date.now() - 42_000).toISOString(), ...fields });

test('child tasks are listed under their own heading: the title opens the child, its elapsed time, a stop while it runs, then Child, its answerer and what it is doing', () => {
  const working = childTask({ sessionId: 'ses_w', title: 'Write the parser tests', state: 'model' });
  const done = childTask({ sessionId: 'ses_d', title: 'Fix the login bug', model: 'claude-sonnet-5-5' });
  const html = render(activity([]), { childTasks: [done, working], delegations: new Map([['ses_w', delegationOf('ses_w', { state: 'model', activity: 'working', done: false })], ['ses_d', delegationOf('ses_d')]]) });
  expect(html).toContain('<section class="child-tasks" aria-label="Child tasks"><h3 class="activity-section-label">Child tasks</h3><ol class="activity-list">');
  // Running first, with a square stop named after it, as a task row has.
  expect(html).toMatch(new RegExp(`<li class="task-row child-task-row" data-state="running" data-session-id="ses_w"><div class="item-head"><button type="button" class="child-task-open" title="Open Write the parser tests">Write the parser tests</button><span class="activity-elapsed">00:4\\d</span>${stopSquare('Write the parser tests')}</div><div class="activity-task-meta">Child · Claude Code · Opus 5.5 · Working</div></li>`));
  expect(html).toContain('<li class="task-row child-task-row" data-state="done" data-session-id="ses_d"><div class="item-head"><button type="button" class="child-task-open" title="Open Fix the login bug">Fix the login bug</button><span class="activity-elapsed">');
  expect(html).toContain('<div class="activity-task-meta">Child · Claude Code · Sonnet 5.5 · Answered · done</div></li>');
  expect(html.indexOf('ses_w')).toBeLessThan(html.indexOf('ses_d'));
  expect(count(html, STOP_SQUARES)).toBe(1);
  // Children are not the process's tasks: the heading offers no Stop background work and does not say Nothing running.
  for (const absent of ['Stop background work', 'Nothing running', 'Clear finished']) expect(html).not.toContain(absent);
});

test('a child that needs the user says so with the alert mark; one without a delegation row says only who answers it', () => {
  const html = render(activity([]), { childTasks: [childTask({ sessionId: 'ses_n', attention: 'needs_you', state: 'awaiting_permission' }), childTask({ sessionId: 'ses_x', title: 'Grandchild' })] });
  expect(html).toMatch(/<div class="activity-task-meta">Child · Claude Code · Opus 5\.5 · <span class="child-needs"><svg[^>]*>.*?<\/svg>Needs you<\/span><\/div>/);
  expect(html).toContain('<div class="activity-task-meta">Child · Claude Code · Opus 5.5</div>');
  expect(html).toMatch(/data-session-id="ses_n"><div class="item-head"><button type="button" class="child-task-open" title="Open Write the parser tests">Write the parser tests<\/button><span class="activity-elapsed"><\/span>/); // no delegation row: no elapsed time
});

test('without children there is no child-task section; Clear finished leaves the children listed', () => {
  expect(render(activity([task({ status: 'completed' })]))).not.toContain('child-task');
  const finished = task({ status: 'completed', description: 'Old command' });
  const children = [childTask({ sessionId: 'ses_k' })];
  const html = render(activity([finished]), { childTasks: children, cleared: clearFinished(activity([finished]), {}) });
  expect(html).not.toContain('Old command');
  expect(html).toContain('data-session-id="ses_k"');
});

test('with no process, what its last one left is listed: an idle activity of finished tasks reads Finished N, not Nothing running', () => {
  const html = render({ ...activity([task({ status: 'stopped', description: 'Earlier command', summary: 'The process ended before it finished' }), task({ status: 'completed', description: 'Earlier agent' })]), state: 'idle' });
  expect(html).toContain('<summary><span>Finished 2</span>');
  expect(html).toContain('The process ended before it finished');
  expect(html).not.toContain('Nothing running');
  expect(html).not.toContain('Stop background work');
  expect(html).toContain('aria-label="Clear finished"');
});

test('a background agent\'s row names its kind and model after Agent; a generic agent with no model reads as before, and so does a command', () => {
  const html = render(activity([
    task({ description: 'Explore the repo', taskType: 'local_agent', subagentType: 'Explore', model: 'claude-opus-5-5', tokens: 12_000, toolUses: 3, startedAt: '2026-10-24T00:00:03.000Z' }),
    task({ description: 'Generic helper', taskType: 'local_agent', subagentType: 'general-purpose', startedAt: '2026-10-24T00:00:02.000Z' }),
    task({ description: 'Plain agent', taskType: 'local_agent', subagentType: 'Agent', model: 'claude-sonnet-5-5', startedAt: '2026-10-24T00:00:01.500Z' }),
    task({ description: 'Watch the build', taskType: 'local_bash', startedAt: '2026-10-24T00:00:01.000Z' }),
  ]));
  expect(html).toContain('<div class="activity-task-meta">Agent · Explore · Opus 5.5 · Running · 12k tokens · 3 tool uses</div>');
  expect(html).toContain('<div class="activity-task-meta">Agent · Running</div>');
  expect(html).toContain('<div class="activity-task-meta">Agent · Sonnet 5.5 · Running</div>'); // a generic kind is left out, its model is not
  expect(html).toContain('<div class="activity-task-meta">Command · Running</div>');
});

test('a task\'s output opens under its row from a chevron after its time, on rows and workflow cards of the process, never on child tasks', () => {
  const html = render(activity([task({ description: 'Watch the build', taskType: 'local_bash' })]), { childTasks: [childTask({ sessionId: 'ses_o', state: 'model' })] });
  expect(html).toMatch(new RegExp(`<span class="activity-elapsed">\\d\\d:\\d\\d</span>${outputToggle()}${stopSquare('Watch the build')}</div>`));
  expect(count(html, /task-output-toggle/g)).toBe(1); // the child row has none
  expect(html).not.toContain('task-output-pane');
  // Open, the pane is under the row, and reads Loading output… until the first answer.
  const row = renderToStaticMarkup(<ol><TaskRow task={task({ description: 'Watch the build', taskType: 'local_bash' })} nested={false} now={Date.now()} onStopTask={noop} outputOpen onOutputToggle={noop} loadOutput={async () => ({ output: 'x', totalBytes: 1, truncated: false })} /></ol>);
  expect(row).toMatch(new RegExp(outputToggle(true)));
  expect(row).toContain('<div class="task-output-pane"><p class="task-output-note">Loading output…</p></div></li>');
  const card = renderToStaticMarkup(<ol><WorkflowCard task={workflow({ workflowName: 'demo' })} nested={false} now={Date.now()} onStopTask={noop} openPhases={new Set()} onPhaseToggle={noop} outputOpen onOutputToggle={noop} loadOutput={async () => ({ output: 'x', totalBytes: 1, truncated: false })} /></ol>);
  expect(card).toContain('task-output-pane');
});

test('the output pane shows the output, a note when earlier output was left out, why it cannot when the process has ended, or the error', () => {
  const view = (props) => renderToStaticMarkup(<TaskOutputView {...props} />);
  const command = task({ description: 'Run the tests', taskType: 'local_bash', status: 'completed', outputFile: '/private/tmp/claude-501/s/tasks/b7x.output' });
  expect(view({ task: command, state: { status: 'ready', result: { output: 'task 1\nline 1\nline 2\n', totalBytes: 21, truncated: false } } })).toBe('<div class="task-output-pane"><pre class="task-output">task 1\nline 1\nline 2\n</pre></div>');
  expect(view({ task: command, state: { status: 'ready', result: { output: 'the end\n', totalBytes: 900000, truncated: true } } })).toBe('<div class="task-output-pane"><pre class="task-output">… earlier output left out\nthe end\n</pre></div>');
  expect(view({ task: command, state: { status: 'error', error: { code: 'no_process', message: 'the process that ran this task has ended' } } }))
    .toBe('<div class="task-output-pane"><p class="task-output-note">The process that ran it has ended</p><p class="task-output-note" title="/private/tmp/claude-501/s/tasks/b7x.output">Output file: b7x.output</p></div>');
  expect(view({ task: { ...command, outputFile: null }, state: { status: 'error', error: { code: 'no_process', message: 'x' } } })).toBe('<div class="task-output-pane"><p class="task-output-note">The process that ran it has ended</p></div>');
  expect(view({ task: command, state: { status: 'error', error: { code: 'not_found', message: 'no such task' } } })).toBe('<div class="task-output-pane"><p class="task-output-note" title="no such task">no such task</p></div>'); // a long error is readable in full on hover
  expect(view({ task: command, state: { status: 'ready', result: { output: '', totalBytes: 0, truncated: false } } })).toBe('<div class="task-output-pane"><p class="task-output-note">No output yet</p></div>');
});

test('the MCP servers\' status is one muted line at the bottom: the non-zero counts, the failed and unsigned ones by name on hover', () => {
  const servers = [
    { name: 'probe', status: 'connected', source: 'user', error: null },
    { name: 'pencil', status: 'failed', source: 'user', error: 'ENOENT' },
    { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai', error: null },
  ];
  const html = render(activity([]), { mcpServers: servers });
  expect(html).toContain('<p class="panel-note mcp-status" title="Failed: pencil (ENOENT)\nNeeds sign-in: claude.ai Gmail">MCP: 1 connected · 1 failed · 1 needs sign-in</p>');
  expect(render(activity([]), { mcpServers: [servers[0], { ...servers[0], name: 'other' }] })).toContain('<p class="panel-note mcp-status">MCP: 2 connected</p>');
  for (const none of [null, [], undefined]) expect(render(activity([]), { mcpServers: none })).not.toContain('mcp-status');
});
