import { dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runChatFoldersSmoke({ window, bridge, project, evaluate, waitFor, report, results }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(process.env.JOLO_SMOKE_SYNC_ROOT)})`);
  await waitFor("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Link local folder')", 'synced folder link action');
  await waitFor("document.body.textContent.includes('Project history restored on this device.')", 'synced history readable before linking');
  await waitFor("Array.from(document.querySelectorAll('.sidebar-workspace-name')).some(el => el.textContent === 'Signals')", 'synced folder name in Projects');
  const before = await evaluate('window.__joloSmoke.state()');
  assert(!before.standalone, 'project task restored as a standalone chat');
  const { workspaces } = await bridge.rawCall('workspace.list', { projectId: before.projectId });
  assert(workspaces.length === 1 && workspaces[0].needsFolder, 'opening placeholder created an unlinked execution workspace');
  let blocked = false;
  try { await bridge.rawCall('terminal.open', { workspaceId: before.workspaceId, cols: 80, rows: 24 }); }
  catch (error) { blocked = String(error).includes('Link this synced folder'); }
  assert(blocked, 'unlinked folder allowed a terminal');
  writeFileSync(path.join(results, 'chat-folder-link.png'), (await window.webContents.capturePage()).toPNG());
  const originalDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  try {
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Link local folder').click()");
    await waitFor("!Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Link local folder')", 'local folder linked');
    await waitFor(`window.__joloSmoke.state().projectId !== ${JSON.stringify(before.projectId)}`, 'merged with the open local project');
    const after = await evaluate('window.__joloSmoke.state()');
    assert(after.sessionId === before.sessionId, 'linking replaced the conversation');
    const { workspaces: linked } = await bridge.rawCall('workspace.list', { projectId: after.projectId });
    assert(linked.some(w => w.id === after.workspaceId && !w.needsFolder), 'linked checkout remains unavailable');
    await waitFor("document.body.textContent.includes('Project history restored on this device.')", 'history retained after linking');
  } finally { dialog.showOpenDialog = originalDialog; }
  report.checks.push('Synced project history stays in its project, blocks an unlinked terminal, and links to an existing local folder without replacing the chat');
}
