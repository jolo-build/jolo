import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';

export async function runFoldersSmoke({ window, bridge, project, results, evaluate, waitFor, report }) {
  const alpha = await bridge.rawCall('project.open', { path: project });
  const betaPath = path.join(project, '..', 'second-folder');
  mkdirSync(betaPath, { recursive: true });
  const beta = await bridge.rawCall('project.open', { path: betaPath });
  const made = [];
  for (let index = 0; index < 103; index++) made.push((await bridge.rawCall('session.create', { projectId: alpha.projectId, workspaceId: alpha.workspaceId, title: index === 0 ? 'Original discussion' : `Chat ${index}` })).session);
  const other = (await bridge.rawCall('session.create', { projectId: beta.projectId, workspaceId: beta.workspaceId, title: 'Discussion in second folder' })).session;
  const { workspace: worktree } = await bridge.rawCall('workspace.create', { projectId: alpha.projectId, branch: 'jolo/folders-fixture', title: 'Empty worktree' });
  const { runWorkspaceSidebarSmoke } = await import('./workspace-sidebar-smoke.js');
  await runWorkspaceSidebarSmoke({ window, bridge, evaluate, waitFor, results, report, alpha, beta, worktree, made, other });
  // Exercise the real button and IPC bridge; substitute only the OS folder picker.
  const originalDialog = dialog.showOpenDialog;
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [betaPath] });
    await evaluate("document.querySelector('.sidebar-open-folder').click()");
    await waitFor(`window.__joloSmoke.state().workspaceId === ${JSON.stringify(beta.workspaceId)} && document.querySelector('.composer textarea')`, 'Open folder shows the selected project');
    const selected = await evaluate('window.__joloSmoke.state().projectId');
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    await evaluate("document.querySelector('.sidebar-open-folder').click()");
    await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    if ((await evaluate('window.__joloSmoke.state().projectId')) !== selected) throw new Error('Canceling folder selection changed the project');
    dialog.showOpenDialog = async () => { throw new Error('Folder picker unavailable'); };
    await evaluate("document.querySelector('.sidebar-open-folder').click()");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Folder picker unavailable')", 'folder picker errors are visible');
    await evaluate("document.querySelector('[aria-label=\"Dismiss error\"]').click()");
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(betaPath, 'missing-folder')] });
    await evaluate("document.querySelector('.sidebar-open-folder').click()");
    await waitFor(`document.querySelector('[role=alert]') && window.__joloSmoke.state().projectId === ${JSON.stringify(selected)}`, 'failed project open keeps the current project with an error');
    report.checks.push('Open folder shows the selected project; cancellation keeps the current one and picker/project errors are visible');
  } finally { dialog.showOpenDialog = originalDialog; }
}
