import { dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { selectPanel } from './panel-controls.js';

export async function runPanelTabsSmoke({ window, bridge, browserHost, project, fixtureUrl, evaluate, waitFor, results, report }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const newTab = async label => {
    await evaluate("document.querySelector('button[aria-label=\"New panel tab\"]').click()");
    await waitFor("Boolean(document.querySelector('.panel-menu:popover-open[aria-label=\"New panel tab\"]'))", 'new tab menu');
    await evaluate(`document.querySelector('.panel-menu:popover-open [aria-label="${label}"]').click()`);
  };
  await evaluate('window.__joloSmoke.showTask()');
  await evaluate('window.__joloSmoke.newTask()');
  const firstSession = await evaluate('window.__joloSmoke.state().sessionId');
  await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(fixtureUrl)})`);
  await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'first browser page');
  const loadingServer = createServer((request, response) => {
    if (request.url === '/fail') { request.socket.destroy(); return; }
    response.setHeader('Content-Type', request.url === '/pending.js' ? 'text/javascript' : 'text/html');
    // Send the document first, then delay its script: loading must continue
    // after navigation commits, until the subresource finishes.
    if (request.url === '/pending.js') setTimeout(() => response.end(''), 2000);
    else response.end('<title>Loading fixture</title><script src="/pending.js"></script><h1>Loaded</h1>');
  });
  await new Promise(resolve => loadingServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const address = loadingServer.address();
    if (!address || typeof address === 'string') throw new Error('Loading fixture has no TCP address');
    const loadingUrl = `http://127.0.0.1:${address.port}`;
    const navigate = async url => evaluate(`(() => {
      const input = document.querySelector('[aria-label="Browser address"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.form.requestSubmit();
    })()`);
    const busy = "Boolean(document.querySelector('[aria-label=\"Stop loading\"] .activity-spin')) && document.querySelector('.browser-content').getAttribute('aria-busy') === 'true'";
    const idle = "Boolean(document.querySelector('[aria-label=\"Reload\"]')) && document.querySelector('.browser-content').getAttribute('aria-busy') === 'false'";
    await navigate(loadingUrl);
    await waitFor(busy, 'address submission shows loading');
    await waitFor("window.__joloSmoke.state().browserTitle === 'Loading fixture'", 'loading document committed');
    assert(await evaluate(busy), 'spinner stopped before subresources finished');
    writeFileSync(path.join(results, 'browser-loading.png'), (await window.webContents.capturePage()).toPNG());
    await waitFor(idle, 'finished page restores reload');
    await evaluate("document.querySelector('[aria-label=\"Reload\"]').click()");
    await waitFor(busy, 'reload shows loading');
    await evaluate("document.querySelector('[aria-label=\"Stop loading\"]').click()");
    await waitFor(idle, 'stopping clears loading');
    await navigate(`${loadingUrl}/fail`);
    await waitFor("Boolean(document.querySelector('.browser [role=alert]'))", 'failed navigation reports an error');
    await waitFor(idle, 'failed navigation clears loading');
    assert(await evaluate("document.querySelector('.browser-content [role=alert] h2')?.textContent === 'Couldn’t load this page' && !document.querySelector('.browser-content').textContent.includes('Your app, right here.')"), 'failed page must show one centered error instead of the welcome message');
    writeFileSync(path.join(results, 'browser-load-error.png'), (await window.webContents.capturePage()).toPNG());
    await navigate(fixtureUrl);
    await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'original page restored');
    await waitFor(idle, 'original page finished');
  } finally { loadingServer.closeAllConnections(); loadingServer.close(); }
  report.checks.push('Browser loading appears on address submission and reload, remains through subresource loading, and clears on completion, stop and failure');
  await evaluate("window.__firstPage = document.querySelector('webview'); window.__firstPage.executeJavaScript('window.tabMarker = 42')");
  await newTab('Browser');
  await waitFor("document.querySelectorAll('webview').length === 2", 'second browser tab');
  assert(await evaluate("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]').textContent === 'New tab'"), 'new browser tab is not selected');
  await evaluate("document.querySelector('[aria-label=\"Panel tabs\"] [role=tab]').click()");
  assert(await evaluate("window.__firstPage.executeJavaScript('window.tabMarker === 42')"), 'browser state lost on switch');
  await evaluate("document.querySelector('[aria-label=\"Close New tab\"]').click()");
  await waitFor("document.querySelectorAll('webview').length === 1", 'closing one browser preserves the other');
  assert(browserHost.guests.size === 1, 'closed browser guest was retained');
  // A release outside the divider, or a missed release followed by idle movement,
  // must remove the resize cursor before the user clicks a browser menu item.
  const debuggerApi = window.webContents.debugger;
  const parentCursors = [];
  const recordCursor = (_event, type) => parentCursors.push(type);
  window.webContents.on('cursor-changed', recordCursor);
  const attachedHere = !debuggerApi.isAttached();
  if (attachedHere) debuggerApi.attach('1.3');
  try {
  await evaluate("window.__recordResizePointer = event => { if (event.target.closest('[role=separator]')) window.__resizePointerId = event.pointerId; }; window.addEventListener('pointerdown', window.__recordResizePointer, true)");
  for (const [selector, marker] of [['.context-divider', '.context-resizing'], ['.sidebar-divider', '.sidebar-resizing']]) {
    for (const release of ['mouseup', 'mousemove', 'blur', 'jolo:browser-focus']) {
      const point = await evaluate(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60) }; })()`);
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      await waitFor(`Boolean(document.querySelector('${marker}'))`, `resize started: ${selector} ${release}`);
      assert(await evaluate(`document.querySelector('${selector}').hasPointerCapture(window.__resizePointerId)`), 'divider did not capture the drag');
      assert(await evaluate("getComputedStyle(document.querySelector('webview')).cursor === 'auto'"), 'resize cursor inherited by the native browser');
      await evaluate(`window.dispatchEvent(new MouseEvent('${release}', { buttons: 0, bubbles: true }))`);
      await waitFor(`!document.querySelector('${marker}')`, 'resize cleanup outside divider');
      assert(await evaluate(`!document.querySelector('${selector}').hasPointerCapture(window.__resizePointerId)`), `cleanup retained pointer capture: ${selector} ${release}`);
      assert(await evaluate(`getComputedStyle(document.querySelector('${selector}')).cursor === 'auto'`), 'released handle still supplies a resize cursor');
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    }
  }
  // Resize across the native guest, release, then send a mouse click to its
  // renderer. The embedder's CDP input does not route into guest webContents.
  await evaluate("window.__firstPage.executeJavaScript(\"document.querySelector('button').style.cursor = 'pointer'; window.menuClicks = 0; document.querySelector('button').onclick = () => window.menuClicks++; void 0;\")");
  const start = await evaluate("(() => { const r = document.querySelector('.context-divider').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+60}; })()");
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 70, y: start.y, buttons: 1 });
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 70, y: start.y, button: 'left', buttons: 0, clickCount: 1 });
  await waitFor("!document.querySelector('.context-resizing')", 'native resize finished');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert(parentCursors.includes('col-resize'), 'fixture never exercised the native parent resize cursor');
  assert(!parentCursors.at(-1)?.includes('resize'), `parent retained resize cursor: ${JSON.stringify(parentCursors)}`);
  const target = await evaluate("(async () => { const r = window.__firstPage.getBoundingClientRect(); const p = await window.__firstPage.executeJavaScript(\"(() => { const r = document.querySelector('button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()\"); return {...p, uncovered:document.elementFromPoint(r.x+p.x,r.y+p.y) === window.__firstPage, captured:document.querySelector('.context-divider').hasPointerCapture(window.__resizePointerId)}; })()");
  assert(target.uncovered && !target.captured, 'divider still intercepts the browser menu');
  const guest = [...browserHost.guests.values()][0].guest;
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
  await waitFor("window.__firstPage.executeJavaScript('window.menuClicks === 1')", 'browser menu receives click after resizing');
  await evaluate("window.__firstPage.executeJavaScript(\"document.querySelector('button').onclick = () => { location.search = 'after-resize'; }; void 0;\")");
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
  await waitFor("window.__firstPage.getURL().includes('?after-resize') && Boolean(document.querySelector('[aria-label=\"Reload\"]'))", 'menu navigation after resize');
  assert(!parentCursors.at(-1)?.includes('resize'), 'navigation restored the parent resize cursor');
  const handle = await evaluate("(() => { const r = document.querySelector('.context-divider').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+60}; })()");
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 40, y: handle.y });
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...handle });
  await waitFor("getComputedStyle(document.querySelector('.context-divider')).cursor === 'col-resize'", 'divider restores resize cursor on re-entry');
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 40, y: handle.y });
  await waitFor("getComputedStyle(document.querySelector('.context-divider')).cursor === 'auto'", 'leaving divider clears its cached cursor');
  } finally { window.webContents.removeListener('cursor-changed', recordCursor); await evaluate("window.removeEventListener('pointerdown', window.__recordResizePointer, true)"); if (attachedHere) debuggerApi.detach(); }
  assert(await evaluate("getComputedStyle(document.querySelector('webview')).cursor !== 'col-resize'"), 'resize cursor leaked into browser');

  await selectPanel(evaluate, waitFor, 'Terminal');
  await waitFor('Boolean(window.__joloTerminal?.ready)', 'first terminal ready');
  await evaluate("window.__firstShell = window.__joloTerminal; window.__firstShell.input('export JOLO_TAB_MARKER=retained\\n')");
  await newTab('Terminal');
  await waitFor('window.__joloTerminals.size === 2 && window.__joloTerminal.ready', 'second terminal ready');
  await evaluate("window.__secondShell = window.__joloTerminal; document.querySelector('[aria-label=\"Panel tabs\"] [data-panel-type=terminal]').click(); window.__firstShell.input('echo $JOLO_TAB_MARKER\\n')");
  await waitFor("window.__firstShell.text().split('\\n').some(line => line.trim() === 'retained')", 'first shell state preserved');
  await evaluate("document.querySelector('[aria-label=\"Close Terminal 2\"]').click()");
  await waitFor('window.__joloTerminals.size === 1', 'second shell disposed');
  const terminals = await bridge.rawCall('terminal.list', { workspaceId: await evaluate('window.__joloSmoke.state().workspaceId') });
  assert(terminals.terminals.length === 1, 'closing a terminal left its process running');

  writeFileSync(path.join(project, 'first.md'), '# First file\n\nPreview retained.\n');
  writeFileSync(path.join(project, 'second.txt'), 'Second file contents');
  const originalDialog = dialog.showOpenDialog;
  let selected = 'first.md';
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(project, selected)] });
  try {
    await selectPanel(evaluate, waitFor, 'Files');
    await newTab('Open file…');
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'first.md'", 'picked first file');
    await evaluate("document.querySelector('.file-heading [role=tab]:last-child').click()");
    selected = 'second.txt';
    await newTab('Open file…');
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'second.txt'", 'picked second file');
    await evaluate("Array.from(document.querySelectorAll('[aria-label=\"Panel tabs\"] [role=tab]')).find(tab => tab.textContent === 'first.md').click()");
    assert(await evaluate("document.querySelector('.changes-host > .panel-item-content:not([hidden]) .file-preview-source')?.textContent.startsWith('# First file')"), 'file source mode was not retained');
    await newTab('Open file…');
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'second.txt'", 'existing file reselected');
    assert(await evaluate("document.querySelectorAll('[aria-label=\"Panel tabs\"] [data-panel-type=file]').length === 2"), 'same file opened duplicate tabs');
    assert(await evaluate("document.querySelectorAll('.context-bar [role=tablist]').length === 1 && !document.querySelector('.context-content [role=tablist][aria-label=\"Panel tabs\"]')"), 'panel items must share one tab row');
    writeFileSync(path.join(results, 'panel-file-tabs.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[aria-label=\"Close second.txt\"]').click()");
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'first.md'", 'closing active tab selects its neighbor');
    await evaluate("document.querySelector('[aria-label=\"Close first.md\"]').click()");
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'Files'", 'closing last file restores file list');
    await waitFor("Array.from(document.querySelectorAll('.tree-file')).some(button => button.textContent.includes('first.md'))", 'new file appears in working files');
    await evaluate("Array.from(document.querySelectorAll('.tree-file')).find(button => button.textContent.includes('first.md')).click()");
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'first.md'", 'working file opens in a new tab');
    await evaluate("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true, cancelable:true}))");
    await waitFor("document.querySelector('[aria-label=\"Panel tabs\"] [aria-selected=true]')?.textContent === 'Jolo smoke page'", 'item tabs support keyboard selection');
  } finally { dialog.showOpenDialog = originalDialog; }
  const firstTabs = await evaluate("Array.from(document.querySelectorAll('[aria-label=\"Panel tabs\"] [role=tab]')).map(tab => tab.textContent)");
  const firstUrl = await evaluate("document.querySelector('webview').getURL()");
  await evaluate('window.__joloSmoke.newTask()');
  const secondSession = await evaluate('window.__joloSmoke.state().sessionId');
  assert(firstSession !== secondSession, 'new task did not create another chat');
  await waitFor("document.querySelector('.inspector').hidden && !document.querySelector('[aria-label=\"Panel tabs\"] [role=tab]') && !document.querySelector('webview')", 'new chat in the same workspace starts without panels');
  await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(`${fixtureUrl}?second-chat`)})`);
  await waitFor("document.querySelector('webview')?.getURL().includes('second-chat')", 'second chat owns a different browser');
  await selectPanel(evaluate, waitFor, 'Terminal');
  await waitFor('window.__joloTerminals.size === 2 && window.__joloTerminal.ready', 'second chat owns a separate shell');
  await evaluate("window.__secondChatShell = window.__joloTerminal; document.querySelector('[aria-label=\"Close Terminal 1\"]').click()");
  await waitFor('window.__joloTerminals.size === 1', 'closing second chat shell preserves first chat shell');
  await evaluate("document.querySelector('.context-close').click()");
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(firstSession)})`);
  await waitFor("!document.querySelector('.inspector').hidden && window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'first chat restores its open panel');
  assert(JSON.stringify(await evaluate("Array.from(document.querySelectorAll('[aria-label=\"Panel tabs\"] [role=tab]')).map(tab => tab.textContent)")) === JSON.stringify(firstTabs), 'first chat tab list changed');
  await waitFor(`document.querySelector('webview')?.getURL() === ${JSON.stringify(firstUrl)}`, 'first chat restores its own browser URL');
  await selectPanel(evaluate, waitFor, 'Terminal');
  await evaluate("window.__firstShell.input('echo $JOLO_TAB_MARKER\\n')");
  await waitFor("window.__firstShell.text().split('\\n').filter(line => line.trim() === 'retained').length >= 2", 'first chat shell environment survives switching chats');
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(secondSession)})`);
  await waitFor("document.querySelector('.inspector').hidden && document.querySelector('webview')?.getURL().includes('second-chat')", 'second chat restores its hidden panel and own URL');
  await evaluate('window.__joloSmoke.newChat()');
  await waitFor("document.querySelector('.inspector').hidden && !document.querySelector('webview') && !document.querySelector('[aria-label=\"Panel tabs\"] [role=tab]')", 'standalone chat starts with clean panels');
  report.checks.push('Chats in the same workspace retain separate tab lists, browser URLs and panel visibility; terminal processes survive chat switches, and new chats start clean');
  report.checks.push('Resize cleanup releases pointer capture on mouse release, idle movement and focus loss; a real browser menu click works after dragging the panel');
  report.checks.push('Native parent cursor resets after resizing and stays reset through page navigation; re-entering a divider restores its resize cursor');
}
