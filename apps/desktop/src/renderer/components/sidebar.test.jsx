import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from './sidebar.jsx';

const project = { projectId: 'prj_1', workspaceId: 'wsp_1', rootPath: '/work/jolo', preferredMode: 'direct' };
const session = (overrides = {}) => ({ id: 'ses_1', title: 'port the build', workspaceId: 'wsp_1', agentId: null, updatedAt: '2026-09-09T12:00:00.000Z', ...overrides });
const task = (overrides = {}) => ({
  sessionId: 'ses_1', title: 'port the build', agentId: null, projectId: 'prj_1', projectName: 'jolo', rootPath: '/work/jolo',
  workspaceId: 'wsp_1', branch: null, mode: 'direct', attention: 'idle', reason: null, summary: null,
  updatedAt: '2026-09-09T12:00:00.000Z', run: null, ...overrides,
});
const render = (props) => renderToStaticMarkup(<Sidebar project={project} sessions={[]} sessionId={null} lastRun={null} onHistory={() => {}} historyState="open" onTaskMenu={() => {}} onSelect={() => {}} {...props} />);

describe('the task list', () => {
  test('the open task count belongs to the All projects tab, not Archive', () => {
    const html = render({ tasksAvailable: true, tasks: Array.from({ length: 6 }, (_, i) => task({ sessionId: `ses_${i}` })) });
    expect(html).toMatch(/id="open-tasks-tab"[^>]*aria-selected="true"[^>]*>All projects<span class="task-tab-count">6<\/span><\/button>/);
    expect(html).toMatch(/id="archived-tasks-tab"[^>]*aria-selected="false"[^>]*>Archive<\/button>/);
    expect(html).toContain('aria-label="Which projects to list"');
  });

  test('shows tasks from every project, saying where each one is', () => {
    const html = render({
      tasksAvailable: true,
      tasks: [task(), task({ sessionId: 'ses_2', title: 'fix the parser', projectId: 'prj_2', projectName: 'other', rootPath: '/work/other', branch: 'fix/parser', agentId: 'codex' })],
      agentName: (id) => (id === 'codex' ? 'Codex' : id),
    });
    expect(html).toContain('port the build');
    expect(html).toContain('fix the parser');
    expect(html).toContain('>jolo<');
    expect(html).toContain('>other<');
    expect(html).toContain('fix/parser');
    expect(html).toContain('Codex');
    expect(html).toContain('All projects'); // the scope can be narrowed only when there is a wider list to narrow
  });

  test('a running task is separated from settled ones, which fold behind a count', () => {
    const html = render({
      tasksAvailable: true,
      tasks: [
        task({ sessionId: 'ses_live', title: 'building', attention: 'running', run: { id: 'run_1', state: 'tools', pauseReason: null, createdAt: new Date(Date.now() - 14_000).toISOString(), updatedAt: new Date().toISOString() } }),
        task({ sessionId: 'ses_done', title: 'finished', attention: 'done', run: { id: 'run_2', state: 'completed', pauseReason: null, createdAt: '2026-09-09T11:00:00.000Z', updatedAt: '2026-09-09T11:05:00.000Z' } }),
      ],
    });
    expect(html).toContain('Working'); // with its elapsed time, so a long run is visible as one
    expect(html).toMatch(/Working \d+s/);
    expect(html).toContain('building');
    expect(html).toContain('Settled (1)');
    expect(html).not.toContain('finished'); // folded away until asked for
  });

  test('a task waiting on the user stays out of the settled fold, wherever it lives', () => {
    const html = render({
      tasksAvailable: true,
      tasks: [task({ sessionId: 'ses_ask', title: 'needs approval', projectName: 'other', attention: 'needs_you', reason: 'awaiting_permission', run: { id: 'run_3', state: 'awaiting_permission', pauseReason: null, createdAt: '2026-09-09T11:00:00.000Z', updatedAt: '2026-09-09T11:01:00.000Z' } })],
    });
    expect(html).toContain('needs approval');
    expect(html).toContain('Needs you');
    expect(html).not.toContain('Settled');
  });

  test('an engine that cannot list across projects falls back to this project, never to an empty list', () => {
    const html = render({
      tasksAvailable: false,
      tasks: [],
      sessions: [session()],
      sessionId: 'ses_1',
      lastRun: { id: 'run_9', state: 'tools', createdAt: new Date(Date.now() - 5_000).toISOString(), updatedAt: new Date().toISOString() },
    });
    expect(html).toContain('port the build'); // the task exists, so the list shows it
    expect(html).toContain('Working');
    expect(html).not.toContain('Your tasks will appear here');
    expect(html).toContain('This project'); // and the header does not claim to span projects
    expect(html).not.toContain('All projects');
  });

  test('the empty state is only for an engine that answered and had nothing to list', () => {
    expect(render({ tasksAvailable: true, tasks: [], sessions: [] })).toContain('Your tasks will appear here');
    expect(render({ tasksAvailable: null, tasks: [], sessions: [] })).toContain('Your tasks will appear here');
    expect(render({ tasksAvailable: null, tasks: [], sessions: [], project: null })).toContain('Choose a project to get started');
  });

  test('the archive stays the project it belongs to, whatever the wider list can do', () => {
    const html = render({ tasksAvailable: true, tasks: [task({ title: 'live one' })], sessions: [session({ title: 'archived one' })], historyState: 'archived' });
    expect(html).toContain('archived one');
    expect(html).not.toContain('live one');
    expect(html).toContain('aria-labelledby="archived-tasks-tab"');
  });
});
