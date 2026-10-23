import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityLine } from '../src/renderer/components/activity-line.jsx';

let ids = 0;
/** @param {Record<string, any>} [options] @returns {import('../src/renderer/activity.js').TaskRecord} */
const task = ({ status = 'running', backgrounded = true } = {}) => ({
  taskId: `t${++ids}`, runId: null, toolUseId: null, description: 'A task', subagentType: null, phase: null, backgrounded, status,
  startedAt: new Date().toISOString(), endedAt: status === 'running' ? null : new Date().toISOString(), usage: { totalTokens: null, toolUses: null, durationMs: null },
});
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks) => ({ state: 'background', tasks, truncated: false, updatedAt: new Date().toISOString() });
const render = (value, stopping = false) => renderToStaticMarkup(<ActivityLine activity={value} workflowNames={new Map()} onStop={() => {}} onOpenPanel={() => {}} stopping={stopping} />);

test('two background tasks read as one line that opens the Activity panel and stops all of them', () => {
  const html = render(activity([task(), task()]));
  expect(html).toContain('class="activity-line" role="status"');
  expect(html).toContain('aria-label="Show background work"');
  expect(html).toContain('Background work: 2 tasks');
  expect(html).toMatch(/<button[^>]*>Stop background work<\/button>/);
});

test('nothing is lit while no background task runs, a foreground subagent included', () => {
  expect(render(null)).toBe('');
  expect(render(activity([task({ status: 'completed' })]))).toBe('');
  expect(render(activity([task({ backgrounded: false })]))).toBe('');
});

test('while the stop is pending its button reads Stopping… and is disabled', () => {
  const html = render(activity([task(), task()]), true);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
  expect(html).not.toContain('Stop background work');
});
