import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar, SidebarTask } from '../src/renderer/components/sidebar.jsx';
import { SidebarChatRow, TypedTitle } from '../src/renderer/components/sidebar-chat-row.jsx';
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
  expect(html).toContain('Options for beta');
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
  expect(html).not.toContain('Options for beta');
});
test('nested chats keep one line and carry the latest answerer and checkout in their tooltip', () => {
  // Only the markup of a single row is under test, so this render leaves off the drag state and the
  // open and menu callbacks: nothing here clicks the row, so nothing here can fire them.
  const html = renderToStaticMarkup(<SidebarTask {...(/** @type {import('react').ComponentProps<typeof SidebarTask>} */ ({ task: { sessionId: 'chat', title: 'Fix parser', projectName: 'Repeated folder', agentId: 'claude', answerer: { id: 'codex', displayName: 'Codex', model: 'gpt-6-astra' }, mode: 'worktree', branch: 'codex/parser', updatedAt: '2026-09-10T00:00:00.000Z', run: { state: 'completed' } }, dragTask: { workspace: { path: '/work/parser' } }, agentName: () => 'Wrong session default', selected: true, onMenu() {} }))} />);
  expect(html).toContain('>Fix parser</span>');
  expect(html).toContain('Done · ');
  expect(html).not.toContain('sidebar-task-progress');
  expect(html).toContain('Codex · GPT 6 Astra · Branch: codex/parser · Worktree · /work/parser"');
  expect(html).toContain('title="Worktree: /work/parser"');
  expect(html).not.toContain('sidebar-chat-details');
  expect(html).not.toContain('Wrong session default');
  expect(html).not.toContain('Repeated folder');
  expect(html).not.toContain('branch-tag');
  expect(html).not.toContain('class="meta"');
  expect(html).toContain('Options for Fix parser');
});

test('task progress marks working, waiting and failed states, and leaves settled ones to the tooltip', () => {
  const row = state => renderToStaticMarkup(<SidebarTask {...(/** @type {import('react').ComponentProps<typeof SidebarTask>} */ ({ task: { sessionId: 'task', title: 'Task', run: state ? { state } : null } }))} />);
  for (const state of ['preparing', 'model', 'tools']) {
    expect(row(state)).toContain('aria-label="Working"');
    expect(row(state)).toContain('activity-spin');
  }
  for (const [state, label] of [['queued', 'Queued'], ['awaiting_permission', 'Needs approval'], ['paused', 'Paused'], ['failed', 'Failed'], ['interrupted', 'Interrupted']]) {
    expect(row(state)).toContain(`aria-label="${label}"`);
    expect(row(state)).not.toContain('activity-spin');
  }
  for (const [state, label] of [['completed', 'Done'], ['cancelled', 'Stopped'], [null, 'Ready']]) {
    expect(row(state)).toContain(`title="Task\n${label}`);
    expect(row(state)).not.toContain('sidebar-task-progress');
  }
  // Child tasks are not listed here, so a settled parent takes the mark when one of them needs the user.
  const parent = renderToStaticMarkup(<SidebarTask {...(/** @type {import('react').ComponentProps<typeof SidebarTask>} */ ({ task: { sessionId: 'task', title: 'Task', run: { state: 'completed' } }, childTasks: [{ sessionId: 'child', attention: 'needs_you' }] }))} />);
  expect(parent).toContain('aria-label="A child task needs you"');
});
test('empty folders remain visible', () => {
  expect(render({ workspaceId: 'beta' })).toContain('Hide tasks in beta');
});

test('collapsed folders show ongoing work even when another task needs attention', () => {
  const props = { board: { projects: [{ ...workspace('alpha', '/work/alpha'), attention: 'needs_you', working: true }] } };
  expect(render(props)).toContain('workspace-folder working');
  expect(render(props)).toContain('aria-label="Tasks working"');
  expect(render({ ...props, historyState: 'archived' })).not.toContain('workspace-folder working');
  expect(render({ board: { projects: [{ ...props.board.projects[0], working: false }] } })).not.toContain('workspace-folder working');
});

test('a chat being named shows a shimmer in place of its title, never the prompt; a blank chat without a run is New chat; a title is the title', () => {
  const row = (task, standalone = false) => renderToStaticMarkup(<SidebarChatRow {...(/** @type {import('react').ComponentProps<typeof SidebarChatRow>} */ ({ task: { sessionId: 'chat', ...task }, standalone }))} />);
  const naming = row({ title: '', run: { state: 'model', prompt: 'Count from 1 to 200 slowly' } }, true);
  expect(naming).toContain('<span class="title-shimmer" role="img" aria-label="Naming…"><span></span></span>');
  expect(naming).toContain('title="Naming…');
  expect(naming).not.toContain('Count from 1');
  expect(naming).not.toContain('New chat');
  const fresh = row({ title: '', run: null }, true);
  expect(fresh).toContain('New chat');
  expect(fresh).not.toContain('title-shimmer');
  expect(row({ title: '', run: null })).toContain('New task');
  const named = row({ title: 'Counting to two hundred', run: { state: 'model' } }, true);
  expect(named).toContain('>Counting to two hundred</span>');
  expect(named).not.toContain('title-shimmer');
});

test('a title already there renders whole, never part-typed; a chat being named renders the shimmer (typing itself starts in an effect)', () => {
  expect(renderToStaticMarkup(<TypedTitle title="Counting to two hundred" naming={false} />)).toBe('Counting to two hundred');
  expect(renderToStaticMarkup(<TypedTitle title="" naming />)).toBe('<span class="title-shimmer" role="img" aria-label="Naming…"><span></span></span>');
  const row = renderToStaticMarkup(<SidebarChatRow {...(/** @type {import('react').ComponentProps<typeof SidebarChatRow>} */ ({ task: { sessionId: 'chat', title: 'Counting to two hundred', run: { state: 'completed' } }, standalone: true }))} />);
  expect(row).toContain('<span class="recent-chat-title">Counting to two hundred</span>');
  expect(row).toContain('title="Counting to two hundred');
});
