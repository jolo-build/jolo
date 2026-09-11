import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';

export async function runBoardSmoke({ window, bridge, project, results, evaluate, waitFor, report }) {
  const alpha = await bridge.rawCall('project.open', { path: project });
  const betaPath = path.join(project, '..', 'second-folder');
  mkdirSync(betaPath, { recursive: true });
  const beta = await bridge.rawCall('project.open', { path: betaPath });
  const made = [];
  for (let index = 0; index < 103; index++) made.push((await bridge.rawCall('session.create', { projectId: alpha.projectId, workspaceId: alpha.workspaceId, title: index === 0 ? 'Original discussion' : `Chat ${index}` })).session);
  const other = (await bridge.rawCall('session.create', { projectId: beta.projectId, workspaceId: beta.workspaceId, title: 'Discussion in second folder' })).session;
  const { workspace: worktree } = await bridge.rawCall('workspace.create', { projectId: alpha.projectId, branch: 'jolo/board-fixture', title: 'Empty worktree' });
  const card = id => `.board-card[data-workspace-id="${id}"]`;
  const alphaCard = JSON.stringify(card(alpha.workspaceId));
  const betaCard = JSON.stringify(card(beta.workspaceId));
  const worktreeCard = JSON.stringify(card(worktree.id));
  const sidebarPreference = await evaluate("localStorage.getItem('jolo.sidebar')");
  await evaluate('window.__joloSmoke.showBoard()');
  await waitFor("document.querySelectorAll('.board-card').length === 3", 'one board row per folder including empty worktrees');
  const checkHiddenSidebar = async () => {
    const value = await evaluate("({ width: document.querySelector('.workspace-sidebar').getBoundingClientRect().width, inert: document.querySelector('.workspace-sidebar').inert, divider: Boolean(document.querySelector('.sidebar-divider')), toggle: Boolean(document.querySelector('.sidebar-toggle')), left: document.querySelector('.pane-canvas').getBoundingClientRect().left })");
    if (value.width !== 0 || !value.inert || value.divider || value.toggle || value.left !== 0) throw new Error(`board still has a sidebar: ${JSON.stringify(value)}`);
  };
  await checkHiddenSidebar();
  if (!(await evaluate("Boolean(document.querySelector('.header [aria-label=Settings]'))"))) throw new Error('settings is inaccessible from the board');
  if (!(await evaluate("document.querySelector('.board-wordmark')?.textContent === 'jolo' && !document.querySelector('.header [aria-label=Changes]') && document.querySelector('.status').hidden"))) throw new Error('board still shows task-specific chrome');
  await evaluate("document.querySelector('.board-account').click()");
  await waitFor("document.querySelector('.settings-heading h1')?.textContent === 'Account'", 'account button opens account settings');
  await evaluate("document.querySelector('[aria-label=\"Back to workspace\"]').click()");
  await waitFor("document.querySelector('.board-header') && !document.querySelector('.settings-page')", 'settings returns to the workspace board');
  await evaluate(`document.querySelector(${alphaCard}).querySelector('.board-expand').click()`);
  await waitFor(`document.querySelector(${alphaCard}).querySelectorAll('.board-task').length === 4`, 'compact workspace shows four recent tasks');
  await evaluate(`document.querySelector(${alphaCard}).querySelector('.board-show-older').click()`);
  await waitFor(`document.querySelector(${alphaCard}).querySelectorAll('.board-task').length === 100`, 'older tasks expand before pagination');
  if (await evaluate(`document.querySelector(${alphaCard}).textContent.includes('Discussion in second folder')`)) throw new Error('tasks leaked between folders');
  await evaluate(`document.querySelector(${betaCard}).querySelector('.board-expand').click()`);
  await waitFor(`document.querySelector(${betaCard}).querySelectorAll('.board-task').length === 1`, 'second workspace expands independently');
  await evaluate(`document.querySelector(${alphaCard}).querySelector('.board-load-more').click()`);
  await waitFor(`document.querySelector(${alphaCard}).querySelectorAll('.board-task').length === 103`, 'older chats are accessible beyond the first task page');
  const target = JSON.stringify(`.board-task[data-session-id="${made[0].id}"]`);
  await evaluate(`document.querySelector(${target}).click()`);
  await waitFor(`window.__joloSmoke.state().view === 'task' && window.__joloSmoke.state().sessionId === ${JSON.stringify(made[0].id)}`, 'clicked task opens the exact chat');
  await waitFor("document.querySelector('.header-task-title')?.textContent === 'Original discussion'", 'older task title survives the sidebar page limit');
  if (!(await evaluate("Boolean(document.querySelector('.header [aria-label=Panels]')) && !document.querySelector('.status').hidden"))) throw new Error('task controls were not restored after leaving the board');
  if ((await evaluate('window.__joloSmoke.state().workspaceId')) !== alpha.workspaceId) throw new Error('opened chat has the wrong folder');
  if (!(await evaluate("document.querySelector('.workspace-sidebar').getBoundingClientRect().width > 0"))) throw new Error('chat sidebar was not restored');
  await evaluate("document.querySelector('#archived-tasks-tab').click()");
  await waitFor("document.querySelector('#archived-tasks-tab')?.getAttribute('aria-selected') === 'true'", 'archive view selected');
  await evaluate('window.__joloSmoke.showBoard()');
  await evaluate(`document.querySelector(${alphaCard}).querySelector('.board-expand').click()`);
  await waitFor(`document.querySelector(${alphaCard}).querySelector('.board-task')`, 'open workspace tasks from archive');
  await evaluate(`document.querySelector(${alphaCard}).querySelector('.board-task').click()`);
  await waitFor("window.__joloSmoke.state().view === 'task' && document.querySelector('#open-tasks-tab')?.getAttribute('aria-selected') === 'true'", 'board task restores open task navigation');
  await evaluate('window.__joloSmoke.showBoard()');
  await checkHiddenSidebar();
  await evaluate(`document.querySelector(${worktreeCard}).querySelector('.board-actions button').click()`);
  await waitFor(`window.__joloSmoke.state().view === 'task' && window.__joloSmoke.state().workspaceId === ${JSON.stringify(worktree.id)}`, 'new task stays in the chosen worktree folder');
  const createdId = await evaluate('window.__joloSmoke.state().sessionId');
  if ((await bridge.rawCall('session.page', { sessionId: createdId })).session.workspaceId !== worktree.id) throw new Error('new task was stored in the main checkout');
  await evaluate('window.__joloSmoke.showBoard()');
  await evaluate(`document.querySelector(${betaCard}).querySelector('.board-expand').click()`);
  await waitFor(`document.querySelector(${betaCard}).querySelector('.board-task')`, 'second folder tasks ready');
  await evaluate(`document.querySelector(${JSON.stringify(`.board-task[data-session-id="${other.id}"]`)}).click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(other.id)} && window.__joloSmoke.state().workspaceId === ${JSON.stringify(beta.workspaceId)}`, 'task navigation crosses workspace projects correctly');
  await evaluate('window.__joloSmoke.showBoard()');
  await evaluate(`document.querySelector(${betaCard}).querySelector('.board-expand').click()`);
  await evaluate(`document.querySelector(${worktreeCard}).querySelector('.board-expand').click()`);
  await waitFor('document.querySelectorAll(".board-workspace-tasks").length === 2', 'expanded board layout');
  const size = window.getSize(), theme = nativeTheme.themeSource;
  try {
    for (const color of /** @type {const} */ (['dark', 'light'])) {
      nativeTheme.themeSource = color;
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const layout = await evaluate(`(() => {
        const head = document.querySelector('.board-head'), folder = document.querySelector('.board-row'), task = document.querySelector('.board-task');
        return { heading: parseFloat(getComputedStyle(head.querySelector('h1')).fontSize), folder: folder.getBoundingClientRect().height, task: task.getBoundingClientRect().height,
          text: parseFloat(getComputedStyle(task).fontSize), newChatInHeader: Boolean(head.querySelector('.board-chat-actions button')), badges: document.querySelectorAll('.board-task .chip').length,
          background: getComputedStyle(document.querySelector('.board')).backgroundColor, page: getComputedStyle(document.body).backgroundColor };
      })()`);
      if (layout.heading !== 20 || layout.text !== 13 || layout.folder > 50 || layout.task > 43 || !layout.newChatInHeader || layout.badges) throw new Error(`compact board geometry regressed: ${JSON.stringify(layout)}`);
      if (layout.page !== (color === 'light' ? 'rgb(252, 252, 251)' : 'rgb(25, 26, 28)')) throw new Error(`desktop palette differs from approved concept: ${JSON.stringify(layout)}`);
      writeFileSync(path.join(results, `workspace-board-${color}.png`), (await window.webContents.capturePage()).toPNG());
    }
    window.setSize(800, 860);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (await evaluate("document.querySelector('.board').scrollWidth > document.querySelector('.board').clientWidth || Boolean(document.querySelector('.board button button'))")) throw new Error('board layout overflows or nests buttons');
    await checkHiddenSidebar();
    writeFileSync(path.join(results, 'workspace-board-narrow.png'), (await window.webContents.capturePage()).toPNG());
  } finally { window.setSize(...size); nativeTheme.themeSource = theme; }
  if ((await evaluate("localStorage.getItem('jolo.sidebar')")) !== sidebarPreference) throw new Error('board changed the saved sidebar preference');
  report.checks.push('folders show four recent chats, expand independently into older chats, and paginate beyond 100 tasks');
  report.checks.push('clicking an older chat opens its exact session; creating a chat in a worktree keeps its folder; cross-project navigation selects the right chat');
  report.checks.push('the board has no sidebar or wasted sidebar space; chats restore the sidebar without changing its saved preference');
  report.checks.push('workspace board renders in both themes and at narrow widths without overflow or nested buttons');
  const { runWorkspaceSidebarSmoke } = await import('./workspace-sidebar-smoke.js');
  await runWorkspaceSidebarSmoke({ window, bridge, evaluate, waitFor, results, report, alpha, beta, worktree, made, other });
}
