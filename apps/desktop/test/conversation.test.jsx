import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/renderer/components/conversation.jsx';

/**
 * A message as the projection holds one, with only the fields a test cares about. The projection
 * fills the rest in as events arrive, so every field here is optional and the tests name the few
 * that drive the rendering they are checking.
 * @typedef {Partial<import('@jolo/client/projection').ProjectedMessage>} PartialMessage
 */

/**
 * Every case here renders the conversation once and reads the markup, so each render passes the
 * projection or the history it is about and leaves off the identifiers, the review handles and the
 * callbacks that only a click would reach. The props are asserted rather than stubbed out, because a
 * stub would suggest a path these cases exercise.
 * @typedef {import('react').ComponentProps<typeof Conversation>} ConversationProps
 */

/**
 * A finished, empty reasoning message, which is the starting point for most of these cases.
 * @param {PartialMessage} [overrides] the fields this case needs to differ
 */
const reasoning = (overrides = {}) => ({ id: 'thinking', role: 'assistant', kind: 'reasoning', text: '', status: 'complete', renderedBytes: 0, committedBytes: 0, ...overrides });
/** @param {PartialMessage[]} messages what the projection returns, newest last */
const render = (...messages) => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => messages, runs: new Map() }, hasProject: true }))} />);

test('saved history loads without a button, shows a deferred mark, and offers retry only on failure', () => {
  const history = { hasOlder: true, loading: false };
  const markup = () => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ history, hasProject: true }))} />);
  expect(markup()).not.toContain('history-loader');
  history.loading = true;
  expect(markup()).toContain('<p class="hint deferred" role="status" aria-label="Loading earlier messages">…</p>');
  expect(markup()).not.toContain('<button');
  history.loading = false;
  history.error = 'offline';
  expect(markup()).toContain('Couldn’t load earlier messages · <button type="button">Retry</button>');
  history.hasOlder = false;
  expect(markup()).not.toContain('history-loader');
});

describe('conversation activity', () => {
  const agents = [
    { id: 'codex', displayName: 'Codex', model: 'gpt-6-astra' },
    { id: 'claude', displayName: 'Claude Code', model: 'claude-opus-4-6' },
  ];
  /**
   * Renders a conversation whose one run is still going, which is the only state these cases care
   * about. `run` is merged into that run, so it carries whichever of the run's fields the case needs:
   * `agentId` for an agent called into the task, and `execution` for what a saved run recorded.
   * @param {{ state?: string, agentId?: string, execution?: { agentId?: string, model?: string } }} [run]
   * @param {PartialMessage[]} [messages] what the projection returns, newest last
   * @param {{ agents?: { id: string, displayName: string, model: string | null }[] }} [props] props this case overrides
   */
  const renderWorking = (run = {}, messages = [reasoning({ runId: 'active', status: 'streaming' })], props = {}) => renderToStaticMarkup(<Conversation
    {...(/** @type {ConversationProps} */ ({
      projection: { ordered: () => messages, runs: new Map([['active', { id: 'active', state: 'model', ...run }]]) },
      hasProject: true, assistantName: 'Codex', assistantAgentId: 'codex', providerModel: 'gpt-5.6-sol', agents,
    }))} {...props}
  />);

  test('a called-in agent names one thinking indicator and keeps its model for hover', () => {
    const html = renderWorking({ agentId: 'claude' });
    expect(html).toContain('Thinking… · Claude Code<');
    expect(html).toContain('title="Claude Code · Opus 4.6"');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toContain('Working');
  });

  test('saved run overrides identify the guest and model before its answer arrives', () => {
    const html = renderWorking({ execution: { agentId: 'claude', model: 'task-specific-model' } }, []);
    expect(html).toContain('Working · Claude Code<');
    expect(html).toContain('title="Claude Code · Task Specific Model"');
    expect(html).not.toContain('Opus');
  });

  test('tool activity uses the usual agent when no guest is called in', () => {
    const html = renderWorking({ state: 'tools' }, [{ id: 'tool', runId: 'active', role: 'tool', kind: 'tool', text: 'run_command bun test', status: 'streaming' }]);
    expect(html).toContain('>1 action<');
    expect(html).toContain('<span>Using tools</span>');
    expect(html).toContain('title="Codex · GPT 6 Astra"');
    expect(html.match(/activity-spin/g)).toHaveLength(1);
    expect(html).not.toContain('activity-pulse');
  });

  test('calling Jolo into a hosted task uses Jolo’s provider model', () => {
    const html = renderWorking({ agentId: 'jolo' });
    expect(html).toContain('Thinking… · Jolo<');
    expect(html).toContain('title="Jolo · GPT 5.6 Sol"');
    expect(html).not.toContain('GPT 6 Astra');
  });

  test('an unknown model names only the agent without borrowing another provider’s model', () => {
    const html = renderWorking({ agentId: 'claude' }, undefined, { agents: [{ id: 'claude', displayName: 'Claude Code', model: null }] });
    expect(html).toContain('Thinking… · Claude Code<');
    expect(html).toContain('title="Claude Code"');
    expect(html).not.toContain('Default model');
    expect(html).not.toContain('GPT 5.6 Sol');
  });

  test('neighboring activity from separate runs retains its own attribution', () => {
    const html = renderWorking({ agentId: 'claude' }, [
      reasoning({ id: 'earlier', runId: 'previous', text: 'Earlier work.', status: 'complete' }),
      reasoning({ id: 'current', runId: 'active', text: 'Current work.', status: 'streaming' }),
    ]);
    expect(html.match(/class="activity-group"/g)).toHaveLength(2);
    expect(html.match(/class="activity-label" title="[^"]*">Reasoning</g)).toHaveLength(2);
    expect(html).toContain('title="Claude Code · Opus 4.6">Reasoning<');
    expect(html).toContain('Thinking… · Claude Code<');
  });

  test('background tools spanning commentary keep separate groups but one task progress indicator', () => {
    const html = renderWorking({ state: 'tools' }, [
      { id: 'background', runId: 'active', role: 'tool', kind: 'tool', text: 'command long-build', status: 'streaming' },
      { id: 'commentary', runId: 'active', role: 'assistant', kind: 'text', text: 'The build is running. Checking the results.', status: 'complete' },
      { id: 'check', runId: 'active', role: 'tool', kind: 'tool', text: 'command check-results', status: 'streaming' },
    ]);
    expect(html.match(/class="activity-group"/g)).toHaveLength(2);
    expect(html.match(/>1 action</g)).toHaveLength(2);
    expect(html.match(/activity-spin/g)).toHaveLength(1);
    expect(html.match(/Using tools/g)).toHaveLength(1);
    expect(html).not.toContain('Working');
    expect(html).toContain('command long-build');
    expect(html).toContain('command check-results');
  });

  test('failed artifact reads show a retry action for answers, reasoning, and tools', () => {
    for (const kind of ['text', 'reasoning', 'tool']) {
      const html = render(reasoning({ kind, committedBytes: 12, loadError: 'connection closed' }));
      expect(html).toContain('role="alert"');
      expect(html).toContain('Retry loading');
      expect(html).not.toContain('Loading reasoning');
      expect(html).not.toContain('<pre');
    }
  });

  test('pending saved answers and tools have a visible loading state', () => {
    expect(render(reasoning({ kind: 'text', committedBytes: 12 }))).toContain('Loading message…');
    expect(render(reasoning({ kind: 'tool', committedBytes: 12 }))).toContain('Loading tool…');
  });
  test('removing a queued follow-up does not label the active conversation stopped', () => {
    const html = renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => [{ id: 'user', runId: 'active', role: 'user', kind: 'text', text: 'work', status: 'complete' }], runs: new Map([['active', { id: 'active', state: 'model' }], ['removed', { id: 'removed', state: 'cancelled' }]]) }, hasProject: true }))} />);
    expect(html).not.toContain('Stopped');
    expect(html).toContain('Working');
  });
  test('a stopped last run leaves no run note behind, while a failed one still explains itself', () => {
    const page = (/** @type {string} */ state) => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => [{ id: 'user', runId: 'last', role: 'user', kind: 'text', text: 'work', status: 'complete' }], runs: new Map([['last', { id: 'last', state, failure: state === 'failed' ? 'quota' : null }]]) }, hasProject: true }))} />);
    expect(page('cancelled')).not.toContain('run-note');
    expect(page('cancelled')).not.toContain('Stopped');
    expect(page('failed')).toContain('Task failed: quota');
  });
  test('the task’s own agent reads its replies without a visible label; a guest is named', () => {
    const reply = { id: 'reply', runId: 'turn', role: 'assistant', kind: 'text', text: '', status: 'complete', committedBytes: 12, renderedBytes: 0 };
    const page = (/** @type {object} */ run) => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => [reply], runs: new Map([['turn', { id: 'turn', state: 'completed', ...run }]]) }, hasProject: true, assistantName: 'Codex', assistantAgentId: 'codex', agents }))} />);
    expect(page({})).toContain('<div class="message-label sr-only">Codex</div>');
    expect(page({ agentId: 'codex' })).toContain('<div class="message-label sr-only">Codex</div>');
    expect(page({ agentId: 'claude' })).toContain('<div class="message-label" title="Called in for this message">Claude Code</div>');
    expect(page({ agentId: 'claude' })).not.toContain('called-in');
  });
  test('completed empty reasoning leaves no empty disclosure or activity heading', () => {
    const html = render(reasoning({ text: ' \n ' }));
    expect(html).not.toContain('<details');
    expect(html).not.toContain('activity-label');
    expect(html).not.toContain('Loading reasoning');
  });

  test('empty streaming reasoning has a live status instead of an empty code block', () => {
    const html = render(reasoning({ status: 'streaming' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Thinking…');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('<details');
  });

  test('reasoning awaiting artifact bytes stays visible until its text arrives', () => {
    expect(render(reasoning({ committedBytes: 12 }))).toContain('Loading reasoning…');
    const html = render(reasoning({ text: 'Checking the layout.', committedBytes: 20, renderedBytes: 20 }));
    expect(html).toMatch(/class="activity-label"[^>]*>Reasoning</);
    expect(html).toContain('<pre>Checking the layout.</pre>');
    expect(html).not.toContain('Loading reasoning');
  });

  test('an empty reasoning block does not obscure a neighboring tool', () => {
    const html = render(reasoning(), { id: 'tool', role: 'assistant', kind: 'tool', text: 'read_file\napp.js', status: 'complete' });
    expect(html).toContain('1 action');
    expect(html).toContain('read_file');
    expect(html).not.toContain('class="block reasoning"');
  });

  test('released reasoning retains the existing history notice', () => {
    expect(render(reasoning({ evicted: true }))).toContain('Older text was released from memory.');
  });
});

test("the agent's own subagents stand on their own line with their model, and say what they are doing while they work", () => {
  const call = 'Agent {"subagent_type":"Explore","description":"Find where tokens refresh","prompt":"Look"}\n↳ model: claude-opus-5-5\n↳ Read src/auth/session.ts\n';
  const tool = (/** @type {PartialMessage} */ overrides) => ({ id: 'agent', role: 'tool', kind: 'tool', runId: 'run', text: call, status: 'streaming', renderedBytes: 0, committedBytes: 0, ...overrides });
  const working = render(tool({}), { id: 'bash', role: 'tool', kind: 'tool', runId: 'run', text: 'Bash {"command":"ls"}\n', status: 'complete', renderedBytes: 0, committedBytes: 0 });
  expect(working).toContain('class="subagent working"');
  expect(working).toContain('<span class="subagent-title">Find where tokens refresh</span><span class="subagent-meta">Explore · Opus 5.5</span>');
  expect(working).toContain('<div class="subagent-now" title="Read src/auth/session.ts">Read session.ts</div>');
  // Its ordinary neighbour stays in the activity group, which counts only that one.
  expect(working).toContain('1 action');
  const done = render(tool({ text: `${call}↳ Edit src/auth/session.ts\n\nTokens refresh in session.ts.\n`, status: 'complete' }));
  expect(done).toContain('class="subagent"');
  expect(done).not.toContain('subagent-now');
  expect(done).toContain('<span class="subagent-meta">1 file edited</span>'); // the file list itself opens with the row
  // A default kind is not named: only the model.
  const plain = render(tool({ text: 'Agent {"subagent_type":"general-purpose","description":"Fix round 6","prompt":"x"}\n↳ model: claude-opus-5-5\n', status: 'streaming' }));
  expect(plain).toContain('<span class="subagent-title">Fix round 6</span><span class="subagent-meta">Opus 5.5</span>');
});

test('a delegation call stands on its own line naming the child and what it is doing, with the raw call behind a disclosure', () => {
  const call = 'mcp__jolo__delegation_status {"delegationId":"del_1","waitMs":600000}\n{"delegation":{"id":"del_1","parentRunId":"run_p","runId":"run_c","sessionId":"ses_c","title":"bg child","modelAlias":"m1","state":"completed","wakeReason":"timeout","failure":null,"execution":{"agentId":"claude","preset":null,"model":"opus","effort":null,"pinned":true},"createdAt":"2026-10-24T00:00:00.000Z","activity":"background","done":false,"partial":true,"output":"started and then a very long answer that the engine cu…\n';
  const tool = { id: 'delegation', role: 'tool', kind: 'tool', runId: 'run', text: call, status: 'complete', renderedBytes: 0, committedBytes: 0 };
  const html = render(tool, { id: 'bash', role: 'tool', kind: 'tool', runId: 'run', text: 'Bash {"command":"ls"}\n', status: 'complete', renderedBytes: 0, committedBytes: 0 });
  expect(html).toContain('class="delegation-block"');
  expect(html).toContain('Child bg child');
  expect(html).toContain('Answered · background work · partial answer · woke: wait timed out');
  expect(html).toMatch(/<button type="button"[^>]*>Open<\/button>/);
  // Its ordinary neighbour stays in the activity group, which counts only that one.
  expect(html).toContain('1 action');
  const line = render(tool);
  expect(line).toContain('<details class="block delegation-details">'); // the raw call opens with it, as a tool block's does
  expect(line.replace(/<details[\s\S]*?<\/details>/g, '')).not.toContain('{&quot;');
  // The live row from delegation.list wins for state and activity; the wake reason stays the result's.
  const live = renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => [tool], runs: new Map() }, hasProject: true, delegations: new Map([['del_1', { id: 'del_1', state: 'completed', activity: 'idle', done: true, partial: false }]]) }))} />);
  expect(live).toContain('Answered · done · woke: wait timed out');
});

test('a delegation call still waiting for its result spins, names the child from its arguments, and has nothing to open yet', () => {
  const html = render({ id: 'delegation', role: 'tool', kind: 'tool', runId: 'run', text: 'mcp__jolo__delegate_task {"modelAlias":"m1","title":"Write tests","prompt":"x"}\n', status: 'streaming', renderedBytes: 0, committedBytes: 0 });
  expect(html).toContain('Child Write tests');
  expect(html.match(/activity-spin/g)).toHaveLength(1);
  expect(html).not.toContain('>Open<');
  // A newer child with the same title lends its state while the result is missing, but no conversation to open.
  const guessed = renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => [{ id: 'delegation', role: 'tool', kind: 'tool', runId: 'run', text: 'mcp__jolo__delegate_task {"modelAlias":"m1","title":"Write tests","prompt":"x"}\n', status: 'streaming', renderedBytes: 0, committedBytes: 0 }], runs: new Map() }, hasProject: true, delegations: new Map([['del_1', { id: 'del_1', sessionId: 'ses_1', title: 'Write tests', state: 'model', activity: 'working', done: false, partial: false }]]) }))} />);
  expect(guessed).toContain('>Working<');
  expect(guessed).not.toContain('>Open<');
});

describe('a Workflow call', () => {
  /** The call's tool message: the head line the engine shows for Claude's Workflow tool, then its reply. */
  const workflowTool = (/** @type {string} */ id, /** @type {string} */ name, reply = 'Workflow started in the background (task wf-1).', runId = 'run') => ({
    id, role: 'tool', kind: 'tool', runId, status: 'complete', renderedBytes: 0, committedBytes: 0,
    text: `Workflow ${JSON.stringify({ script: `export const meta = {\n  name: '${name}',\n  description: 'Workflow ${name}',\n  phases: [{ title: 'Say' }],\n}\nphase('Say')\n` })}\n${reply}\n`,
  });
  let ids = 0;
  /**
   * A workflow task as `session.activity` carries one, with Claude's progress report of its one phase's agents.
   * @param {{ name?: string, status?: string, startedAt?: string, endedAt?: string | null, agents?: number, done?: number, running?: number }} [options]
   */
  const flow = ({ name = 'demo', status = 'running', startedAt = new Date(Date.now() - 60_000).toISOString(), endedAt = null, agents = 2, done = 0, running = agents } = {}) => ({
    taskId: `wf-${++ids}`, runId: null, toolUseId: null, description: `Workflow ${name}`, subagentType: null, taskType: 'local_workflow', workflowName: name,
    phase: null, backgrounded: false, status, startedAt, endedAt, usage: { totalTokens: null, toolUses: null, durationMs: null },
    workflow: { phases: [{ index: 1, title: 'Say', agents, done, running, failed: 0 }], agents: { total: agents, running, done, failed: 0 }, current: null },
  });
  /** @param {PartialMessage[]} messages @param {any[]} tasks @param {Map<string, object>} [runs] the projection's runs */
  const page = (messages, tasks, runs = new Map()) => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({
    projection: { ordered: () => messages, runs }, hasProject: true,
    activity: { state: 'background', tasks, truncated: false, updatedAt: new Date().toISOString() },
  }))} />);
  const cards = (/** @type {string} */ html) => [...html.matchAll(/<div class="workflow-call"[\s\S]*?<\/div><\/div>(?=<|$)/g)].map(match => match[0]);
  const meta = (/** @type {string} */ card) => [...(card.match(/<div class="workflow-call-meta">([\s\S]*?)<\/div>/)?.[1] ?? '').matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(match => match[1]);
  const squares = (/** @type {string} */ card) => [...card.matchAll(/data-status="(\w+)"/g)].map(match => match[1]);

  test('stands as a card naming the running workflow, its agents and elapsed time, a square per agent, and a way into Activity', () => {
    const html = page([workflowTool('call', 'demo')], [flow()]);
    const [card] = cards(html);
    expect(cards(html)).toHaveLength(1);
    expect(card).toStartWith('<div class="workflow-call" data-state="running"><button type="button" class="workflow-call-head" aria-label="Show demo in Activity"><span class="workflow-call-title">demo</span><svg');
    expect(card).toMatch(/<span class="workflow-call-title">demo<\/span><svg[^>]*class="icon activity-disclosure"[^>]*>.*?<\/svg><\/button>/);
    const words = meta(card);
    expect(words.slice(0, 2)).toEqual(['Workflow', '2 agents']);
    expect(words[2]).toMatch(/^\d\d:\d\d$/);
    expect(words).toHaveLength(3); // no status word while it runs
    expect(squares(card)).toEqual(['running', 'running']);
    expect(card).toContain('<div class="phase-squares" role="img" aria-label="2 running">');
    // No raw view, no stop of its own, nothing of the generic tool block.
    for (const absent of ['<details', '<pre', 'stop-task', '1 action', 'Workflow {']) expect(html).not.toContain(absent);
  });

  test('a stopped workflow’s card says Stopped, and its agents read stopped', () => {
    const [card] = cards(page([workflowTool('call', 'demo')], [flow({ status: 'stopped', startedAt: '2026-10-24T10:00:00.000Z', endedAt: '2026-10-24T10:02:33.000Z' })]));
    expect(card).toStartWith('<div class="workflow-call" data-state="stopped">');
    expect(meta(card)).toEqual(['Workflow', '2 agents', '02:33', 'Stopped']);
    expect(squares(card)).toEqual(['stopped', 'stopped']);
  });

  test('a call with no task of its name says Workflow and the first line of its reply, the whole on hover, with no squares', () => {
    const html = page([workflowTool('call', 'demo', 'SyntaxError: Unexpected token (3:4)\n    at line 3')], [flow({ name: 'other' })]);
    const [card] = cards(html);
    expect(card).toStartWith('<div class="workflow-call" data-state="unknown"><button type="button" class="workflow-call-head" aria-label="Show demo in Activity"><span class="workflow-call-title">demo</span>');
    expect(meta(card)).toEqual(['Workflow', 'SyntaxError: Unexpected token (3:4)']);
    expect(card).toContain('<span class="workflow-call-reply" title="SyntaxError: Unexpected token (3:4)\n    at line 3">SyntaxError: Unexpected token (3:4)</span>');
    expect(card).not.toContain('phase-squares');
  });

  test('two calls of one name claim its two tasks in order: the first card shows the older task', () => {
    const newer = flow({ agents: 3, startedAt: new Date(Date.now() - 10_000).toISOString() });
    const older = flow({ agents: 2, startedAt: new Date(Date.now() - 60_000).toISOString() });
    const found = cards(page([workflowTool('first', 'demo'), workflowTool('second', 'demo')], [newer, older]));
    expect(found.map(card => meta(card)[1])).toEqual(['2 agents', '3 agents']);
  });

  const at = (/** @type {number} */ seconds) => new Date(Date.parse('2026-10-24T10:00:00.000Z') + seconds * 1000).toISOString();

  test('a card takes only a task that started during its own run: an earlier run’s card leaves a later process’s task to the later card', () => {
    const runs = new Map([
      ['early', { id: 'early', state: 'completed', createdAt: at(0), updatedAt: at(20) }],
      ['late', { id: 'late', state: 'completed', createdAt: at(100), updatedAt: at(130) }],
    ]);
    const found = cards(page([workflowTool('a', 'demo', undefined, 'early'), workflowTool('b', 'demo', undefined, 'late')], [flow({ startedAt: at(101) })], runs));
    expect(found).toHaveLength(2);
    expect(found[0]).toStartWith('<div class="workflow-call" data-state="unknown">');
    expect(found[1]).toStartWith('<div class="workflow-call" data-state="running">');
    // A run still going has no end yet: its card takes a task that started since.
    const going = new Map([['early', { id: 'early', state: 'tools', createdAt: at(0), updatedAt: at(1) }]]);
    expect(cards(page([workflowTool('a', 'demo', undefined, 'early')], [flow({ startedAt: at(101) })], going))[0]).toStartWith('<div class="workflow-call" data-state="running">');
  });

  test('a run known without createdAt (first seen through its usage) counts as unknown: its card takes what is left', () => {
    const task = flow({ startedAt: at(0) });
    expect(cards(page([workflowTool('a', 'demo')], [task], new Map([['run', { id: 'run', usage: {} }]])))[0]).toStartWith('<div class="workflow-call" data-state="running">');
    // Known with its times, the same run's window leaves out a task from long before it.
    const known = new Map([['run', { id: 'run', state: 'completed', createdAt: at(3600), updatedAt: at(3630) }]]);
    expect(cards(page([workflowTool('a', 'demo')], [task], known))[0]).toStartWith('<div class="workflow-call" data-state="unknown">');
  });

  test('any other tool line is still a generic tool block, not a card', () => {
    const html = page([{ id: 'bash', role: 'tool', kind: 'tool', runId: 'run', text: 'Bash {"command":"ls"}\napp.js\n', status: 'complete', renderedBytes: 0, committedBytes: 0 }], [flow()]);
    expect(html).not.toContain('workflow-call');
    expect(html).toContain('1 action');
    expect(html).toContain('Bash {&quot;command&quot;:&quot;ls&quot;}');
  });
});

describe('a text message', () => {
  /** A finished text message of `role`, its text all loaded. @param {PartialMessage} [overrides] */
  const said = (overrides = {}) => ({ id: 'said', runId: 'run', role: 'assistant', kind: 'text', text: 'Done: **app.js** is fixed.', status: 'complete', renderedBytes: 26, committedBytes: 26, ...overrides });
  /** Each message's row of tools, which closes its article. @param {string} html */
  const rows = (html) => [...html.matchAll(/<div class="message-tools">([\s\S]*?)<\/div>(?=<\/article>)/g)].map(match => match[1]);
  const exact = (/** @type {string} */ iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  test('yours and the agent’s each end with a copy button and when they were sent, the exact time on hover', () => {
    const createdAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const found = rows(render(said({ id: 'asked', role: 'user', text: 'fix app.js', createdAt }), said({ createdAt })));
    expect(found).toHaveLength(2);
    for (const row of found) {
      expect(row).toStartWith('<button type="button" class="message-copy" aria-label="Copy message" title="Copy message">');
      const time = row.match(/<time class="message-time" dateTime="([^"]*)" title="([^"]*)">([^<]*)<\/time>$/);
      expect(time?.slice(1, 3)).toEqual([createdAt, exact(createdAt)]);
      expect(time?.[3]).toMatch(/^\d+m ago$/);
    }
  });

  test('without a time (from an older engine) it has the copy button alone', () => {
    const [row] = rows(render(said()));
    expect(row).toContain('class="message-copy"');
    expect(row).not.toContain('<time');
  });

  test('reasoning, a tool, a released or failed message, and one still loading its text have no row', () => {
    const createdAt = new Date().toISOString();
    for (const message of [
      reasoning({ text: 'Checking the layout.', createdAt }),
      { id: 'tool', runId: 'run', role: 'tool', kind: 'tool', text: 'read_file\napp.js', status: 'complete', createdAt },
      said({ evicted: true, createdAt }),
      said({ loadError: 'connection closed', createdAt }),
      said({ text: '', renderedBytes: 0, createdAt }),
    ]) expect(render(message)).not.toContain('message-tools');
  });
});
