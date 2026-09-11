import { writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ipcMain, nativeTheme } from 'electron';

export async function runVisualizationSmoke({ window, project, results, evaluate, waitFor, report }) {
  if (await evaluate('window.jolo.homeDirectory()') !== os.homedir()) throw new Error('desktop home directory handler is unavailable');
  await evaluate("window.__joloSmoke.send('Show a visualization')");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", 'visualization reply completed');
  await waitFor("document.querySelectorAll('.visualization').length === 2", 'markers become preview blocks');
  if (await evaluate("document.querySelector('.conversation').textContent.includes('visualize')")) throw new Error('raw marker still visible');
  await evaluate("document.querySelector('.visualization').scrollIntoView({block:'center'})");
  await waitFor("Boolean(document.querySelector('.visualization iframe'))", 'inline frame loaded');
  const frame = () => window.webContents.mainFrame.frames.find(item => item.url.startsWith('jolo-visualization:'));
  const deadline = Date.now() + 15000;
  while (!(frame() && await frame().executeJavaScript("Boolean(document.querySelector('#increment'))").catch(() => false))) {
    if (Date.now() > deadline) throw new Error('visualization document did not render');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await frame().executeJavaScript("document.querySelector('#increment').click()");
  if (await frame().executeJavaScript("document.querySelector('#count').textContent") !== '1') throw new Error('visualization scripts did not work');
  const isolation = await frame().executeJavaScript(`(async()=>{
    let parentReadable=false,storageReadable=false;
    try { parentReadable=Boolean(parent.document.body); } catch {}
    try { localStorage.setItem('preview-test','yes'); storageReadable=true; } catch {}
    let network=false;try { await fetch('https://example.invalid/preview-test');network=true; }catch{}
    return {parentReadable,storageReadable,network,bridge:typeof window.jolo,node:typeof require};
  })()`);
  if (isolation.parentReadable || isolation.storageReadable || isolation.network || isolation.bridge !== 'undefined' || isolation.node !== 'undefined') throw new Error(`preview escaped isolation: ${JSON.stringify(isolation)}`);
  const originalUrl = window.webContents.getURL();
  await frame().executeJavaScript("try{top.location='https://example.invalid/preview-top'}catch{};try{window.open('https://example.invalid/preview-popup')}catch{}");
  if (window.webContents.getURL() !== originalUrl) throw new Error('preview navigated the app');
  const theme = nativeTheme.themeSource;
  nativeTheme.themeSource = 'light';
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(path.join(results, 'visualization-inline.png'), (await window.webContents.capturePage()).toPNG());
  nativeTheme.themeSource = theme;
  await evaluate("document.querySelector('[aria-label=\"Expand Interactive preview\"]').click()");
  await waitFor("Boolean(document.querySelector('.visualization-modal[open] iframe'))", 'expanded preview opens');
  await evaluate("document.querySelector('[aria-label=\"Close preview\"]').click()");
  await waitFor("!document.querySelector('.visualization-modal')", 'expanded preview closes');
  await evaluate("document.querySelectorAll('.visualization')[1].scrollIntoView({block:'center'})");
  await waitFor("Boolean(document.querySelector('.visualization [role=alert]'))", 'missing file has a retry fallback');
  writeFileSync(path.join(realpathSync(project), 'missing-preview.html'), '<h2>Recovered preview</h2>');
  await evaluate("document.querySelector('.visualization [role=alert] button').click()");
  await waitFor("Boolean(document.querySelectorAll('.visualization')[1].querySelector('iframe'))", 'retry reads a newly available file');
  const rejected = await evaluate("window.jolo.prepareVisualization({sessionId:window.__joloSmoke.state().sessionId,path:'/outside/preview.html'})");
  if (rejected.ok || !rejected.error.includes('outside')) throw new Error('preview read outside its chat workspace');
  const saved = await evaluate('window.__joloSmoke.state()');
  window.webContents.reload();
  await waitFor(`Boolean(document.querySelector('.board-card[data-workspace-id="${saved.workspaceId}"]'))`, 'workspace listed after reload');
  await evaluate(`document.querySelector('.board-card[data-workspace-id="${saved.workspaceId}"] .board-expand').click()`);
  await waitFor(`Boolean(document.querySelector('.board-task[data-session-id="${saved.sessionId}"]'))`, 'saved task listed after reload');
  await evaluate(`document.querySelector('.board-task[data-session-id="${saved.sessionId}"]').click()`);
  await waitFor("document.querySelectorAll('.visualization').length === 2", 'saved markers render after reload');
  await evaluate("document.querySelector('.visualization').scrollIntoView({block:'center'})");
  await waitFor("Boolean(document.querySelector('.visualization iframe'))", 'saved visualization reloads');
  report.checks.push('streamed and saved visualization markers render as interactive sandboxed previews with expansion and a retry fallback');
  report.checks.push('visualizations cannot access parent DOM, app APIs, Node, browser storage, network fetch, or paths outside their chat workspace');

  // Reproduce a freshly reloaded renderer talking to a main process without the handler.
  ipcMain.removeHandler('jolo:visualization:prepare');
  window.webContents.reload();
  await waitFor(`Boolean(document.querySelector('.board-card[data-workspace-id="${saved.workspaceId}"]'))`, 'workspace listed with outdated host');
  await evaluate(`document.querySelector('.board-card[data-workspace-id="${saved.workspaceId}"] .board-expand').click()`);
  await waitFor(`Boolean(document.querySelector('.board-task[data-session-id="${saved.sessionId}"]'))`, 'saved task listed with outdated host');
  await evaluate(`document.querySelector('.board-task[data-session-id="${saved.sessionId}"]').click()`);
  await waitFor("Boolean(document.querySelector('.visualization'))", 'saved preview on outdated host');
  await evaluate("document.querySelector('.visualization').scrollIntoView({block:'center'})");
  await waitFor("document.querySelector('.visualization [role=alert]')?.textContent.includes('Restart Jolo')", 'missing handler explains desktop restart');
  if (await evaluate("Boolean(document.querySelector('.visualization [role=alert] button')) || document.querySelector('.visualization').textContent.includes('No handler registered')")) throw new Error('outdated host shows a futile retry or raw IPC error');
  report.checks.push('the home directory handler is registered; an outdated desktop explains that a restart is required instead of offering a broken retry');
}
