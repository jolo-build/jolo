import { writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ipcMain, nativeTheme } from 'electron';

/**
 * The runner hands every check the same bag. This one drives the renderer alone, so the engine bridge
 * arrives and goes unread.
 * @param {{
 *   window: import("electron").BrowserWindow,
 *   bridge?: unknown,
 *   project: string,
 *   results: string,
 *   evaluate: (code: string) => Promise<any>,
 *   waitFor: (code: string, label: string, timeoutMs?: number) => Promise<void>,
 *   report: { checks: string[] },
 * }} options
 */
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
  // Generated fragments rely on these shared styles; missing tokens made whole bars invisible.
  const primitives = /** @type {{grid: string, card: string, color: string, padding: number}} */ (await frame().executeJavaScript(`(()=>{
    const root=document.createElement('section');root.id='style-regression';
    root.innerHTML='<div class="viz-grid"><div class="card viz-stat"><span>Published</span><span class="viz-stat-value">45</span></div><div class="card viz-stat">Retained</div></div><div id="regression-bar" style="height:10px;background:var(--green)"></div><div id="regression-tall" style="height:1900px"></div>';
    document.body.append(root);
    const card=root.querySelector('.card'),bar=root.querySelector('#regression-bar');
    return {grid:getComputedStyle(root.firstChild).display,card:getComputedStyle(card).display,color:getComputedStyle(bar).backgroundColor,padding:parseFloat(getComputedStyle(document.body).paddingLeft)};
  })()`));
  if (primitives.grid !== 'grid' || primitives.card !== 'flex' || primitives.color === 'rgba(0, 0, 0, 0)' || primitives.padding < 14) throw new Error(`missing visualization primitives: ${JSON.stringify(primitives)}`);
  await waitFor("document.querySelector('.visualization iframe')?.clientHeight > 1900", 'long preview grows beyond the old nested-scroll limit');
  const longHeight = await evaluate("document.querySelector('.visualization iframe').clientHeight");
  await frame().executeJavaScript("document.querySelector('#style-regression').remove()");
  await waitFor(`document.querySelector('.visualization iframe')?.clientHeight < ${longHeight - 1500}`, 'preview shrinks when content is removed');
  // What the preview reports about itself; the assertions below are the point of the check.
  const isolation = /** @type {{ parentReadable: boolean, storageReadable: boolean, network: boolean, bridge: string, node: string }} */ (await frame().executeJavaScript(`(async()=>{
    let parentReadable=false,storageReadable=false;
    try { parentReadable=Boolean(parent.document.body); } catch {}
    try { localStorage.setItem('preview-test','yes'); storageReadable=true; } catch {}
    let network=false;try { await fetch('https://example.invalid/preview-test');network=true; }catch{}
    return {parentReadable,storageReadable,network,bridge:typeof window.jolo,node:typeof require};
  })()`));
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
  await evaluate("document.querySelector('[aria-label=\"Expand Interactive preview\"]').click()");
  await waitFor("Boolean(document.querySelector('.visualization-modal[open] iframe'))", 'preview reopens for keyboard check');
  const expandedUrl = await evaluate("document.querySelector('.visualization-modal iframe').src");
  const expandedFrame = () => window.webContents.mainFrame.frames.filter(item => item.url === expandedUrl).at(-1);
  const keyboardDeadline = Date.now() + 10000;
  while (!(expandedFrame() && await expandedFrame().executeJavaScript("Boolean(document.querySelector('#increment'))").catch(() => false))) {
    if (Date.now() > keyboardDeadline) throw new Error('expanded frame did not load');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // A message from the inline sibling must not dismiss the expanded frame.
  await frame().executeJavaScript(`parent.postMessage({type:'jolo:visualization-escape',id:location.pathname.slice(1)},'*')`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  if (!await evaluate("Boolean(document.querySelector('.visualization-modal'))")) throw new Error('inline frame dismissed expanded preview');
  await expandedFrame().executeJavaScript("document.querySelector('#increment').focus()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor("!document.querySelector('.visualization-modal')", 'Escape closes a focused sandboxed preview');
  report.checks.push('Escape closes the expanded preview from inside its sandbox; sibling frames cannot dismiss it');
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
