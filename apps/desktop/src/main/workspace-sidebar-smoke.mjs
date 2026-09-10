import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';

export async function runWorkspaceSidebarSmoke({ window, bridge, evaluate, waitFor, results, report, alpha, beta, worktree, made, other }) {
  const group = id => `.sidebar-workspace[data-workspace-id="${id}"]`;
  const alphaGroup = JSON.stringify(group(alpha.workspaceId));
  const betaGroup = JSON.stringify(group(beta.workspaceId));
  const worktreeGroup = JSON.stringify(group(worktree.id));
  await evaluate(`window.__joloSmoke.openTarget(${JSON.stringify(alpha.rootPath)}, ${JSON.stringify(made[0].id)})`);
  await waitFor(`document.querySelectorAll('.sidebar-workspace').length === 3 && document.querySelector(${alphaGroup}).querySelector('.task[aria-current=page]')`, 'current workspace expands around the selected older chat');
  if (await evaluate("Boolean(document.querySelector('.settled-toggle')) || document.querySelector('#open-tasks-tab').textContent.includes('All projects')")) throw new Error('flat task list survived');
  await waitFor(`document.querySelector(${alphaGroup}).querySelector('.sidebar-load-more')`, 'older workspace tasks available');
  await evaluate(`document.querySelector(${alphaGroup}).querySelector('.sidebar-load-more').click()`);
  await waitFor(`document.querySelector(${alphaGroup}).querySelectorAll('.task').length === 103 && !document.querySelector(${alphaGroup}).querySelector('.sidebar-load-more')`, 'sidebar pages without duplicating selected older chat');
  const original = (await bridge.rawCall('session.page', { sessionId: made[0].id })).session;
  await bridge.rawCall('session.rename', { sessionId: original.id, expectedRevision: original.revision, title: 'Renamed older discussion' });
  await waitFor("document.querySelector('.header-task-title').textContent === 'Renamed older discussion'", 'rename reaches selected task beyond the sidebar session page');
  await evaluate(`(() => { const button = document.querySelector(${betaGroup}).querySelector('.sidebar-workspace-toggle'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`);
  await waitFor(`document.querySelector(${betaGroup}).querySelector('.task')`, 'second workspace expands');
  await evaluate(`document.querySelector(${betaGroup}).querySelector('.task').click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(other.id)} && window.__joloSmoke.state().workspaceId === ${JSON.stringify(beta.workspaceId)}`, 'nested task opens across folders');
  const otherSession = (await bridge.rawCall('session.page', { sessionId: other.id })).session;
  await bridge.rawCall('session.archive', { sessionId: other.id, expectedRevision: otherSession.revision, archived: true });
  await evaluate("document.querySelector('#archived-tasks-tab').click()");
  await waitFor(`document.querySelector(${betaGroup}).querySelector('.task')?.textContent.includes('Discussion in second folder')`, 'archived tasks load inside their folder');
  await evaluate(`document.querySelector(${betaGroup}).querySelector('.task').click()`);
  await waitFor("document.querySelector('#archived-tasks-tab').getAttribute('aria-selected') === 'true' && document.querySelector('.resume-note')?.textContent.includes('Restore task')", 'opening archived chat preserves archive and restore action');
  await evaluate("document.querySelector('.resume-note button').click()");
  await waitFor(`!document.querySelector(${betaGroup}).querySelector('.task')`, 'restored chat disappears from archive');
  await evaluate("document.querySelector('#open-tasks-tab').click()");
  await waitFor(`document.querySelector(${betaGroup}).querySelector('.task')`, 'restored chat reappears under its folder');
  await evaluate(`document.querySelector(${worktreeGroup}).querySelector('.sidebar-workspace-new').click()`);
  await waitFor(`window.__joloSmoke.state().workspaceId === ${JSON.stringify(worktree.id)} && window.__joloSmoke.state().sessionId`, 'folder plus creates task in worktree');
  const firstNew = await evaluate('window.__joloSmoke.state().sessionId');
  await evaluate("document.querySelector('.new-task').click()");
  await waitFor(`window.__joloSmoke.state().sessionId !== ${JSON.stringify(firstNew)} && window.__joloSmoke.state().workspaceId === ${JSON.stringify(worktree.id)}`, 'top new-task button preserves selected folder');
  const selectedNew = await evaluate('window.__joloSmoke.state().sessionId');
  await evaluate("document.querySelector('#archived-tasks-tab').click()");
  await waitFor(`document.querySelector('#archived-tasks-tab').getAttribute('aria-selected') === 'true' && window.__joloSmoke.state().workspaceId === ${JSON.stringify(worktree.id)}`, 'archive preserves the selected workspace');
  await evaluate("document.querySelector('#open-tasks-tab').click()");
  await waitFor(`document.querySelector(${worktreeGroup}).querySelectorAll('.task').length === 3`, 'worktree task list restored');
  await evaluate(`document.querySelector(${JSON.stringify(`.sidebar .task[data-session-id="${selectedNew}"]`)}).click()`);
  // Keep the screenshot focused on the hierarchy rather than a long open folder.
  await evaluate(`(() => { const button = document.querySelector(${alphaGroup}).querySelector('.sidebar-workspace-toggle'); if (button.getAttribute('aria-expanded') === 'true') button.click(); })()`);
  await waitFor(`document.querySelector(${worktreeGroup}).querySelectorAll('.task').length === 3 && document.querySelector(${worktreeGroup}).querySelector('.task-tab-count').textContent === '3'`, 'worktree chats and folder count refreshed');
  const badgeSession = (await bridge.rawCall('session.page', { sessionId: firstNew })).session;
  await bridge.rawCall('session.setAgent', { sessionId: firstNew, agentId: 'claude', expectedRevision: badgeSession.revision });
  await waitFor(`document.querySelector(${JSON.stringify(`.task[data-session-id="${firstNew}"] .branch-tag`)})?.textContent === 'Claude Code'`, 'long agent badge ready');
  const size = window.getSize(), theme = nativeTheme.themeSource;
  try {
    for (const color of ['dark', 'light']) {
      nativeTheme.themeSource = color;
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(path.join(results, `workspace-sidebar-${color}.png`), (await window.webContents.capturePage()).toPNG());
    }
    window.setSize(800, 860);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (await evaluate("document.querySelector('.task-list').scrollWidth > document.querySelector('.task-list').clientWidth || Boolean(document.querySelector('.sidebar button button'))")) throw new Error('sidebar overflows or nests buttons');
    const badgeFits = await evaluate(`(() => { const task = document.querySelector(${JSON.stringify(`.task[data-session-id="${firstNew}"]`)}); const badge = task.querySelector('.branch-tag'); const progress = task.querySelector('.task-progress'); const a = badge.getBoundingClientRect(), b = progress.getBoundingClientRect(); return badge.scrollWidth <= badge.clientWidth && (a.top >= b.bottom || a.left >= b.right + 4); })()`);
    if (!badgeFits) throw new Error('agent badge overlaps status or is unnecessarily truncated');
    writeFileSync(path.join(results, 'workspace-sidebar-narrow.png'), (await window.webContents.capturePage()).toPNG());
  } finally { window.setSize(...size); nativeTheme.themeSource = theme; }
  const { run } = await bridge.rawCall('run.start', { sessionId: selectedNew, requestId: 'folder-animation', prompt: 'Show ongoing folder activity' });
  await evaluate(`(() => { const button = document.querySelector(${worktreeGroup}).querySelector('.sidebar-workspace-toggle'); if (button.getAttribute('aria-expanded') === 'true') button.click(); })()`);
  await waitFor(`document.querySelector(${worktreeGroup}).querySelector('.workspace-folder.working') && !document.querySelector(${worktreeGroup}).querySelector('.sidebar-workspace-chats')`, 'collapsed folder animates while its task works');
  const point = await evaluate(`(() => { const r = document.querySelector(${worktreeGroup}).querySelector('.sidebar-workspace-toggle').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await waitFor(`getComputedStyle(document.querySelector(${worktreeGroup}).querySelector('.sidebar-workspace-new')).opacity === '1'`, 'folder actions visible on hover');
  if (await evaluate(`getComputedStyle(document.querySelector(${worktreeGroup}).querySelector('.sidebar-workspace-toggle')).backgroundColor !== 'rgba(0, 0, 0, 0)'`)) throw new Error('folder hover has a second background');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(path.join(results, 'workspace-sidebar-working.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.__joloSmoke.showBoard()');
  await waitFor(`document.querySelector('.board-card[data-workspace-id="${worktree.id}"] .workspace-folder.working')`, 'board folder also shows ongoing work');
  await bridge.rawCall('run.cancel', { runId: run.id });
  await waitFor("!document.querySelector('.board .workspace-folder.working')", 'folder animation stops after cancellation');
  report.checks.push('sidebar folders expand into paginated chats, retain the selected older chat without duplicates, and update its title after rename');
  report.checks.push('sidebar navigation crosses folders; Archive groups tasks by folder and supports opening and restoring them');
  report.checks.push('both folder plus and the top New task create chats in the selected worktree; sidebar fits light, dark, and narrow layouts');
  report.checks.push('collapsed sidebar folders and board folders animate during work, stop when cancelled, and folder hover has a single background');
}
