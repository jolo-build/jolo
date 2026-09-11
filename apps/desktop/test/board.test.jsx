import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Board, BoardTask, WorkspaceRow, workspaceOrder, boardSummary } from '../src/renderer/components/board.jsx';

const row = (id, folder, taskCount = 2) => ({ workspaceId: id, workspace: { path: `/work/${folder}`, mode: 'direct' }, name: folder, git: { branch: null }, attention: 'idle', run: null, taskCount });
test('board lists folders as workspaces with task counts and disclosure controls', () => {
  const html = renderToStaticMarkup(<Board board={{ projects: [row('b', 'beta', 0), row('a', 'alpha')] }} connected />);
  expect(html).toContain('>Workspaces</h1>');
  expect(html).toContain('Show tasks in alpha');
  expect(html).toContain('New task in beta');
  expect(html).toContain('0 tasks');
  expect(html.indexOf('data-workspace-id="a"')).toBeLessThan(html.indexOf('data-workspace-id="b"'));
  expect(html).not.toContain('Where you left off');
});
test('expanding a workspace reveals its task list region', () => {
  const html = renderToStaticMarkup(<WorkspaceRow row={row('a', 'alpha')} expanded now={Date.now()} />);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('aria-label="Tasks in alpha"');
  expect(html).toContain('Loading tasks…');
});

test('workspace activity hides internal tool names and keeps attention visible alongside ongoing work', () => {
  const html = renderToStaticMarkup(<WorkspaceRow row={{ ...row('a', 'alpha', 7), working: true, attention: 'needs_you', run: { state: 'tools' }, actions: [{ name: 'codex:commandExecution' }], summary: 'Running codex:commandExecution' }} />);
  expect(html).toContain('7 tasks');
  expect(html).toContain('workspace-folder working');
  expect(html).toContain('Needs attention');
  expect(html).not.toContain('codex:commandExecution');
  expect(html).not.toContain('board-state');
});

test('attention and ongoing work come first, followed by recent workspace activity', () => {
  const rows = [row('idle', 'alpha'), { ...row('recent', 'zeta'), lastActivityAt: '2026-09-11T10:00:00Z' }, { ...row('busy', 'busy'), working: true }, { ...row('needs', 'needs'), working: true, attention: 'needs_you' }];
  expect(rows.sort(workspaceOrder).map(item => item.workspaceId)).toEqual(['needs', 'busy', 'recent', 'idle']);
  expect(boardSummary(rows)).toBe('1 needs attention · 2 working');
  const html = renderToStaticMarkup(<Board board={{ projects: rows }} connected />);
  expect(html).toContain('aria-label="Tasks in busy"');
  expect(html).toContain('aria-label="Tasks in needs"');
  expect(html).not.toContain('aria-label="Tasks in alpha"');
});

test('completed tasks keep an accessible status without a repeated badge; live labels hide tool internals', () => {
  const task = { sessionId: 'task', title: 'Review comments', updatedAt: '2026-09-11T10:00:00Z', attention: 'done', run: { state: 'completed' } };
  const html = renderToStaticMarkup(<BoardTask task={task} row={row('a', 'alpha')} now={Date.parse('2026-09-11T11:00:00Z')} />);
  expect(html).toContain('aria-label="Review comments, Done, 1h ago"');
  expect(html).toContain('aria-label="New result"');
  expect(html).not.toContain('chip');
  expect(html).not.toContain('board-task-state');
  const active = renderToStaticMarkup(<BoardTask task={{ ...task, attention: 'running', run: { state: 'tools' } }} row={row('a', 'alpha')} />);
  expect(active).toContain('>Working</span>');
  expect(active).not.toContain('board-task-updated');
  expect(active).not.toContain('running tools');
});
