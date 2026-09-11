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
const render = (...messages) => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => messages, runs: new Map() }, hasProject: true, changesCount: 0 }))} />);

test('saved history exposes a load action, progress, and retryable errors', () => {
  const history = { hasOlder: true, loading: false };
  const markup = () => renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ history, hasProject: true, changesCount: 0 }))} />);
  expect(markup()).toContain('Load earlier messages');
  history.loading = true;
  expect(markup()).toContain('Loading earlier messages…');
  expect(markup()).toContain('disabled');
  history.loading = false;
  history.error = 'offline';
  expect(markup()).toContain('Try again.');
  history.hasOlder = false;
  expect(markup()).not.toContain('Load earlier messages');
});

describe('conversation activity', () => {
  const agents = [
    { id: 'codex', displayName: 'Codex', model: 'codex-model' },
    { id: 'claude', displayName: 'Claude Code', model: 'claude-model' },
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
      hasProject: true, changesCount: 0, assistantName: 'Codex', assistantAgentId: 'codex', providerModel: 'jolo-model', agents,
    }))} {...props}
  />);

  test('a called-in agent and its model label one thinking indicator', () => {
    const html = renderWorking({ agentId: 'claude' });
    expect(html).toContain('Thinking… · Claude Code · claude-model');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toContain('Working · Codex');
  });

  test('saved run overrides identify the guest and model before its answer arrives', () => {
    const html = renderWorking({ execution: { agentId: 'claude', model: 'task-specific-model' } }, []);
    expect(html).toContain('Working · Claude Code · task-specific-model');
    expect(html).not.toContain('claude-model');
  });

  test('tool activity uses the usual agent when no guest is called in', () => {
    const html = renderWorking({ state: 'tools' }, [{ id: 'tool', runId: 'active', role: 'tool', kind: 'tool', text: 'run_command bun test', status: 'streaming' }]);
    expect(html).toContain('Task activity · 1 action');
    expect(html).toContain('Using tools · Codex · codex-model');
    expect(html.match(/activity-spin/g)).toHaveLength(1);
  });

  test('calling Jolo into a hosted task uses Jolo’s provider model', () => {
    const html = renderWorking({ agentId: 'jolo' });
    expect(html).toContain('Thinking… · Jolo · jolo-model');
    expect(html).not.toContain('codex-model');
  });

  test('an unknown model is labeled as the default without borrowing another provider’s model', () => {
    const html = renderWorking({ agentId: 'claude' }, undefined, { agents: [{ id: 'claude', displayName: 'Claude Code', model: null }] });
    expect(html).toContain('Thinking… · Claude Code · Default model');
    expect(html).not.toContain('jolo-model');
  });

  test('neighboring activity from separate runs retains its own attribution', () => {
    const html = renderWorking({ agentId: 'claude' }, [
      reasoning({ id: 'earlier', runId: 'previous', text: 'Earlier work.', status: 'complete' }),
      reasoning({ id: 'current', runId: 'active', text: 'Current work.', status: 'streaming' }),
    ]);
    expect(html.match(/class="activity-group"/g)).toHaveLength(2);
    expect(html).toContain('Task activity · Reasoning');
    expect(html).toContain('Thinking… · Claude Code · claude-model');
  });

  test('background tools spanning commentary keep separate groups but one task progress indicator', () => {
    const html = renderWorking({ state: 'tools' }, [
      { id: 'background', runId: 'active', role: 'tool', kind: 'tool', text: 'command long-build', status: 'streaming' },
      { id: 'commentary', runId: 'active', role: 'assistant', kind: 'text', text: 'The build is running. Checking the results.', status: 'complete' },
      { id: 'check', runId: 'active', role: 'tool', kind: 'tool', text: 'command check-results', status: 'streaming' },
    ]);
    expect(html.match(/class="activity-group"/g)).toHaveLength(2);
    expect(html.match(/Task activity · 1 action/g)).toHaveLength(2);
    expect(html.match(/activity-spin/g)).toHaveLength(1);
    expect(html.match(/Using tools · Codex · codex-model/g)).toHaveLength(1);
    expect(html).not.toContain('Working ·');
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
    const html = renderToStaticMarkup(<Conversation {...(/** @type {ConversationProps} */ ({ projection: { ordered: () => [{ id: 'user', runId: 'active', role: 'user', kind: 'text', text: 'work', status: 'complete' }], runs: new Map([['active', { id: 'active', state: 'model' }], ['removed', { id: 'removed', state: 'cancelled' }]]) }, hasProject: true, changesCount: 0 }))} />);
    expect(html).not.toContain('Stopped');
    expect(html).toContain('Working');
  });
  test('completed empty reasoning leaves no empty disclosure or activity heading', () => {
    const html = render(reasoning({ text: ' \n ' }));
    expect(html).not.toContain('<details');
    expect(html).not.toContain('Task activity');
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
    expect(html).toContain('Task activity');
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
