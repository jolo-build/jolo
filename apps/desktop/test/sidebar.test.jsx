import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar, SidebarTask } from '../src/renderer/components/sidebar.jsx';
const workspace = (id, path, taskCount = 0) => ({ workspaceId: id, workspace: { path, mode: 'direct' }, taskCount });
const board = { projects: [workspace('alpha', '/work/alpha', 3), workspace('beta', '/work/beta')] };
const render = props => renderToStaticMarkup(<Sidebar board={board} historyState="open" {...props} />);

test('sidebar lists projects with independent disclosure controls and quiet archive navigation', () => {
  const html = render({});
  expect(html).toContain('>Projects</button>');
  expect(html).toContain('aria-label="Archived tasks"');
  expect(html).not.toContain('task-tab-count');
  expect(html).toContain('Show tasks in alpha');
  expect(html).toContain('Show tasks in beta');
  expect(html).toContain('New task in beta');
  expect(html).not.toContain('Settled');
  expect(html).not.toContain('All projects');
});
test('current folder expands and an older selected chat stays visible before pagination loads', () => {
  const html = render({ workspaceId: 'alpha', sessionId: 'old', sessions: [{ id: 'old', workspaceId: 'alpha', state: 'open', title: 'Original discussion', updatedAt: '2026-09-10T00:00:00.000Z' }] });
  expect(html).toContain('Hide tasks in alpha');
  expect(html).toContain('Show tasks in beta');
  expect(html).toContain('Original discussion');
  expect(html).toContain('aria-current="page"');
});
test('archive keeps folder grouping without showing open task counts or selected open chats', () => {
  const html = render({ historyState: 'archived', workspaceId: 'alpha', sessionId: 'old', sessions: [{ id: 'old', workspaceId: 'alpha', state: 'open', title: 'Open chat' }] });
  expect(html).toContain('aria-labelledby="archived-tasks-tab"');
  expect(html).toContain('Hide tasks in alpha');
  expect(html).not.toContain('Open chat');
  expect(html).not.toContain('New task in beta');
});
test('nested chats show the latest answerer, progress and checkout details', () => {
  // Only the markup of a single row is under test, so this render leaves off the drag state and the
  // open and menu callbacks: nothing here clicks the row, so nothing here can fire them.
  const html = renderToStaticMarkup(<SidebarTask {...(/** @type {import('react').ComponentProps<typeof SidebarTask>} */ ({ task: { sessionId: 'chat', title: 'Fix parser', projectName: 'Repeated folder', agentId: 'claude', answerer: { id: 'codex', displayName: 'Codex', model: 'gpt-6-astra' }, mode: 'worktree', branch: 'codex/parser', updatedAt: '2026-09-10T00:00:00.000Z', run: { state: 'completed' } }, dragTask: { workspace: { path: '/work/parser' } }, agentName: () => 'Wrong session default', selected: true, onMenu() {} }))} />);
  expect(html).toContain('Fix parser');
  expect(html).toContain('Done');
  expect(html).toContain('Codex');
  expect(html).toContain('>Codex · gpt-6-astra</span>');
  expect(html).toContain('aria-label="Done"');
  expect(html).toContain('>codex/parser</span>');
  expect(html).toContain('title="Worktree: /work/parser"');
  expect(html).not.toContain('Wrong session default');
  expect(html).not.toContain('Repeated folder');
  expect(html).not.toContain('branch-tag');
  expect(html).not.toContain('class="meta"');
  expect(html).toContain('Options for Fix parser');
});

test('task progress covers running, waiting and terminal states without changing the working icon', () => {
  const row = state => renderToStaticMarkup(<SidebarTask {...(/** @type {import('react').ComponentProps<typeof SidebarTask>} */ ({ task: { sessionId: 'task', title: 'Task', run: state ? { state } : null } }))} />);
  for (const state of ['preparing', 'model', 'tools']) {
    expect(row(state)).toContain('aria-label="Working"');
    expect(row(state)).toContain('activity-spin');
  }
  for (const [state, label] of [['queued', 'Queued'], ['awaiting_permission', 'Needs approval'], ['paused', 'Paused'], ['completed', 'Done'], ['failed', 'Failed'], ['interrupted', 'Interrupted'], ['cancelled', 'Stopped'], [null, 'Ready']]) {
    expect(row(state)).toContain(`aria-label="${label}"`);
    expect(row(state)).not.toContain('activity-spin');
  }
});
test('hidden sidebar does not mount chat loaders and empty folders remain visible', () => {
  const html = render({ workspaceId: 'beta', visible: false });
  expect(html).toContain('Hide tasks in beta');
  expect(html).not.toContain('Loading tasks');
});

test('collapsed folders show ongoing work even when another task needs attention', () => {
  const props = { board: { projects: [{ ...workspace('alpha', '/work/alpha'), attention: 'needs_you', working: true }] } };
  expect(render(props)).toContain('workspace-folder working');
  expect(render(props)).toContain('aria-label="Tasks working"');
  expect(render({ ...props, historyState: 'archived' })).not.toContain('workspace-folder working');
  expect(render({ board: { projects: [{ ...props.board.projects[0], working: false }] } })).not.toContain('workspace-folder working');
});
