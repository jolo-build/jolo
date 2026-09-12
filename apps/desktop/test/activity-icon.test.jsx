import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/renderer/components/conversation.jsx';

// Model the tool/result/next-tool sequence that used to flash a checkmark.
// Only the activity summary's markup is read here, so the identifiers, review handles and callbacks
// a click would reach are left off and the props asserted; stubbing them would suggest this case
// exercises paths it never takes.
/**
 * @param {string | undefined} state
 * @param {string[]} statuses
 */
function summary(state, statuses) {
  const messages = statuses.map((status, index) => ({ id: `tool-${index}`, runId: 'run', kind: 'tool', role: 'tool', text: 'read file.js', status }));
  const projection = { ordered: () => messages, runs: new Map([['run', { id: 'run', state }]]) };
  const props = /** @type {import('react').ComponentProps<typeof Conversation>} */ ({ projection, hasProject: true, changedFiles: [] });
  const html = renderToStaticMarkup(<Conversation {...props} />);
  return html.match(/<details class="activity-group"><summary>(.*?)<span class="activity-label"/s)[1];
}

test('activity icon stays stable through tool completion gaps and later calls', () => {
  const active = summary('tools', ['streaming']);
  expect(summary('model', ['complete'])).toBe(active);
  expect(summary('tools', ['complete', 'streaming'])).toBe(active);
  expect(summary('awaiting_permission', ['complete'])).toBe(active);
  expect(summary('completed', ['complete'])).not.toBe(active);
});

test('failed, interrupted, and missing run states never imply successful completion', () => {
  const active = summary('tools', ['streaming']);
  for (const state of ['failed', 'interrupted', 'cancelled', undefined]) {
    expect(summary(state, ['complete'])).toBe(active);
  }
});
