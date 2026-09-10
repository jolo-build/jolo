import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Board, WorkspaceRow } from './board.jsx';

const row = (id, folder, taskCount = 2) => ({ workspaceId: id, workspace: { path: `/work/${folder}`, mode: 'direct' }, name: folder, git: { branch: null }, attention: 'idle', run: null, taskCount });
test('board lists folders as workspaces with task counts and disclosure controls', () => {
  const html = renderToStaticMarkup(<Board board={{ projects: [row('b', 'beta', 0), row('a', 'alpha')] }} connected />);
  expect(html).toContain('Your workspaces');
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
  expect(html).toContain('>Working</span>');
  expect(html).toContain('Needs attention');
  expect(html).not.toContain('codex:commandExecution');
  expect(html).not.toContain('board-state');
});
