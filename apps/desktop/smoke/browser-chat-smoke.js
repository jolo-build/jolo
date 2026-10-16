// Real renderer -> chat run -> engine tools -> host -> Chromium. No UI opener or
// direct navigation is called by the test: the scripted agent must do both.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectPanel, hidePanel } from './panel-controls.js';

export async function runRealBrowserAgentSmoke({ window, bridge, browserHost, fixtureUrl, evaluate, waitFor, report, results, agentId }) {
  const state = await evaluate('window.__joloSmoke.state()');
  const { session } = await bridge.rawCall('session.create', { projectId: state.projectId, workspaceId: state.workspaceId, agentId, title: 'Inline browser integration check' });
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(session.id)})`);
  await evaluate('window.__joloSmoke.showTask()');
  await waitFor(`document.querySelector('.model-select')?.textContent.includes(${JSON.stringify(agentId)})`, 'real agent selected');
  for (const attempt of ['first', 'resumed']) {
    if (browserHost.guests.size) await evaluate('window.__joloSmoke.closeBrowser()');
    await waitFor("!document.querySelector('webview')", 'browser starts closed');
    const runsBefore = await evaluate('window.__joloSmoke.state().runCount');
    await evaluate(`window.__joloSmoke.send(${JSON.stringify(`Open ${fixtureUrl} in Jolo's inline browser, click the Click button, and take a screenshot. Confirm the button says Clicked. This is a browser integration test; do not edit files.`)})`);
    await waitFor(`window.__joloSmoke.state().runCount > ${runsBefore} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, `${agentId} browser run finished`, 120_000);
    const page = await bridge.rawCall('session.page', { sessionId: session.id });
    const run = page.runs.at(-1);
    if (run.state !== 'completed') throw new Error(`${agentId} browser run ${run.state}: ${JSON.stringify(run.failure)}`);
    const texts = await Promise.all(page.messages.filter(message => message.runId === run.id && message.kind === 'tool').map(async message => (await bridge.rawCall('artifact.read', { artifactId: message.artifactId })).text));
    if (texts.some(text => /^cua_repl\/|^computer[-_]use\//.test(text))) throw new Error('agent used computer use for the inline browser');
    for (const name of ['browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_screenshot']) if (!texts.some(text => text.includes(name))) throw new Error(`${agentId} did not call ${name}: ${texts.join('\n').slice(0,2500)}`);
    await waitFor("document.querySelector('.inspector').hidden", 'completed agent browser task closes its panel');
    const guest = [...browserHost.guests.values()][0]?.guest;
    if (!guest || await guest.executeJavaScript("document.querySelector('button')?.textContent") !== 'Clicked') throw new Error('agent did not control the inline page');
    writeFileSync(path.join(results, `browser-${agentId}-${attempt}.png`), (await window.webContents.capturePage()).toPNG());
    report.checks.push(`${agentId} ${attempt} turn opened the inline browser, navigated, inspected, clicked, and captured a screenshot through Jolo tools without computer use`);
  }
}

export async function runBrowserChatSmoke({ bridge, browserHost, fixtureUrl, evaluate, waitFor, report, window, results }) {
  if (browserHost.guests.size || await evaluate("Boolean(document.querySelector('webview'))")) throw new Error('browser must start closed for the chat-opening test');
  const runsBefore = await evaluate('window.__joloSmoke.state().runCount');
  await evaluate(`window.__joloSmoke.send(${JSON.stringify(`Open ${fixtureUrl} in the inline browser, click the button, and take a screenshot.`)})`);
  await waitFor(`window.__joloSmoke.state().runCount > ${runsBefore} && ['completed','failed','paused'].includes(window.__joloSmoke.state().runState)`, 'browser run finished', 30_000);
  const state = await evaluate('window.__joloSmoke.state()');
  if (state.runState !== 'completed') throw new Error(`browser run ended ${state.runState}: ${state.toolText.slice(0, 1200)}`);
  await waitFor("document.querySelector('.inspector').hidden && !!document.querySelector('webview')", 'completed browser task closes its panel and retains the page');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(path.join(results, 'browser-task-completed.png'), (await window.webContents.capturePage()).toPNG());
  report.checks.push('Successful browser task automatically closes its panel and leaves the page available to reopen');
  await selectPanel(evaluate, waitFor, 'Browser');
  await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page' && !document.querySelector('.browser-start')", 'chat opened and navigated the inline browser');
  if (!state.assistantText.includes('Clicked the button.')) throw new Error(`unexpected browser-run text: ${state.assistantText}`);
  const guest = [...browserHost.guests.values()][0]?.guest;
  let buttonText;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    buttonText = await guest.executeJavaScript("document.querySelector('button').textContent");
    if (buttonText === 'Clicked') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (buttonText !== 'Clicked') throw new Error(`agent click did not reach the page: ${buttonText}`);
  await waitFor("!!document.querySelector('.browser-agent-cursor')", 'agent cursor rendered over the inline browser');
  const cursor = await evaluate(`(() => {
    const cursor = document.querySelector('.browser-agent-cursor');
    return { x: parseFloat(cursor.style.left) / 100, y: parseFloat(cursor.style.top) / 100,
      pointerEvents: getComputedStyle(cursor).pointerEvents, label: cursor.textContent };
  })()`);
  const target = await guest.executeJavaScript(`(() => {
    const rect = document.querySelector('button').getBoundingClientRect();
    return { left: rect.left / innerWidth, right: rect.right / innerWidth, top: rect.top / innerHeight, bottom: rect.bottom / innerHeight };
  })()`);
  // Clicking changes the label and width from “Click” to “Clicked”; the cursor stays at the click location.
  if (cursor.x < target.left || cursor.x > target.right || cursor.y < target.top || cursor.y > target.bottom || cursor.pointerEvents !== 'none' || !cursor.label.includes('Jolo')) throw new Error(`invalid agent cursor: ${JSON.stringify({ cursor, target })}`);
  if (!cursor.label.includes('Checking network')) throw new Error(`read-only browser work did not update the cursor: ${cursor.label}`);
  writeFileSync(path.join(results, 'browser-cursor.png'), (await window.webContents.capturePage()).toPNG());
  await waitFor("document.querySelector('.browser-agent-cursor')?.dataset.visible === 'false'", 'idle agent cursor fades');
  report.checks.push('Agent cursor follows the clicked target, passes through input, and fades when idle');
  if (!state.toolText.includes('"artifactId"') || !state.toolText.includes('browser_screenshot')) throw new Error('screenshot tool result missing');
  if (!state.toolText.includes('browser_network') || !state.toolText.includes(`"url":"${fixtureUrl}"`)) throw new Error(`network observation missing: ${state.toolText.slice(-600)}`);
  if (![...bridge.agent.hosts.values()].some(host => host.capabilityId)) throw new Error('browser host did not register');
  await runComputerUseSmoke({ bridge, guest, report });
  guest.focus();
  guest.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
  for (const deadline = Date.now() + 3000; guest.getZoomFactor() === 1 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 30));
  if (guest.getZoomFactor() <= 1) throw new Error('Keyboard zoom did not reach the browser');
  guest.setZoomFactor(1);
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: -120, modifiers: 2 });
  for (const deadline = Date.now() + 3000; guest.getZoomFactor() === 1 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 30));
  if (guest.getZoomFactor() <= 1) throw new Error('Wheel zoom did not reach the browser');
  guest.setZoomFactor(1);
  report.checks.push('Keyboard and real Ctrl-wheel input zoom the embedded page');
  // Hiding a panel must not destroy/reload its Electron guest or page state.
  const guestId = guest.id;
  await guest.executeJavaScript("window.__preservedPage = 'still-here'");
  await hidePanel(evaluate, waitFor);
  await waitFor("document.querySelector('.inspector').hidden && !!document.querySelector('webview')", 'browser hidden without unmounting');
  await selectPanel(evaluate, waitFor, 'Browser');
  await waitFor("!document.querySelector('.inspector').hidden", 'browser shown again');
  await selectPanel(evaluate, waitFor, 'Changes');
  await waitFor("document.querySelector('.browser-host').hidden", 'browser hidden behind changes');
  await selectPanel(evaluate, waitFor, 'Browser');
  await waitFor("!document.querySelector('.browser-host').hidden", 'browser restored from changes');
  if (guest.isDestroyed() || [...browserHost.guests.values()][0]?.guest.id !== guestId || await guest.executeJavaScript("window.__preservedPage") !== 'still-here') throw new Error('Hiding the browser destroyed or reloaded its page');
  report.checks.push('Browser toggle and Changes preserve the same guest and in-page state');
  const other = (await bridge.rawCall('session.create', { projectId: state.projectId, workspaceId: state.workspaceId, title: 'Other browser chat' })).session;
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(other.id)})`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(other.id)} && document.querySelector('.inspector').hidden`, 'other chat has its own panel state');
  if (guest.isDestroyed() || ![...bridge.agent.hosts.values()].some(host => host.guest === guest && host.capabilityId)) throw new Error('Switching chats detached the browser host');
  // The two chats share one workspace: a late open must retain the requesting chat.
  const originalCall = bridge.rawCall;
  const openedReplies = [];
  bridge.rawCall = function(method, params) {
    if (method === 'browser.openResult' && params.invocationId === 'smoke-background-chat') { openedReplies.push(params); return Promise.resolve({ accepted: true }); }
    return originalCall.call(this, method, params);
  };
  try {
    bridge.browserOpener.handleOpen({ invocationId: 'smoke-background-chat', workspaceId: state.workspaceId, sessionId: state.sessionId, leaseMs: 15_000 });
    for (const deadline = Date.now() + 15_000; !openedReplies.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 30));
    const reply = openedReplies[0];
    const originalHost = [...bridge.agent.hosts.values()].find(host => host.guest.id === guestId);
    if (!reply || reply.error || reply.capabilityId !== originalHost?.capabilityId) throw new Error(`background chat open chose the wrong guest: ${JSON.stringify(reply)}`);
    const current = await evaluate('window.__joloSmoke.state().sessionId');
    if (current !== other.id || !await evaluate("document.querySelector('.inspector').hidden")) throw new Error('background browser open changed the visible chat or its panel');
    if (browserHost.guests.size !== 1) throw new Error('background browser open created a tab in the current chat');
    report.checks.push('A background browser open in the same workspace returns the originating chat’s guest and leaves the active chat unchanged');
  } finally { bridge.rawCall = originalCall; }
  await guest.executeJavaScript("document.title = 'Background browser preserved'");
  await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(state.sessionId)})`);
  await waitFor("!document.querySelector('.inspector').hidden && window.__joloSmoke.state().browserTitle === 'Background browser preserved'", 'original browser panel and background title restored');
  if (guest.isDestroyed() || guest.id !== guestId || await guest.executeJavaScript('window.__preservedPage') !== 'still-here') throw new Error('Switching chats reloaded the browser');
  report.checks.push('Switching chats preserves the live browser guest, host registration, page state, background titles, and panel visibility on return');
  const tabsBefore = browserHost.guests.size;
  const newUrl = fixtureUrl + '?new-tab=1';
  await guest.executeJavaScript(`(() => { const link = document.createElement('a'); link.href = ${JSON.stringify(newUrl)}; link.target = '_blank'; link.textContent = 'Open new tab'; document.body.append(link); link.click(); })()`, true);
  await waitFor(`(() => { try { return document.querySelector('.panel-item-content:not([hidden]) webview')?.getURL() === ${JSON.stringify(newUrl)}; } catch { return false; } })()`, 'target blank opens selected inline tab');
  if (browserHost.guests.size !== tabsBefore + 1 || guest.getURL() !== fixtureUrl || await guest.executeJavaScript('window.__preservedPage') !== 'still-here') throw new Error('New-window link replaced the original page or failed to create one tab');
  const newGuest = [...browserHost.guests.values()].find(({ guest: item }) => item.id !== guestId)?.guest;
  if (!newGuest || newGuest.session !== guest.session) throw new Error('New tab lost workspace cookies/session');
  await evaluate("document.querySelector('.inspector:not([hidden]) .panel-item-tab[data-active=true] .panel-item-close').click()");
  await evaluate("document.querySelector('[role=tab][aria-label=\"Background browser preserved\"]').click()");
  await waitFor(`(() => { try { return [...document.querySelectorAll('.browser-host:not([hidden]) .panel-item-content:not([hidden]) webview')].some(view => view.getWebContentsId() === ${guestId}); } catch { return false; } })()`, 'closing new tab restores original page');
  report.checks.push('target=_blank links open a selected inline tab with the same workspace session and preserve the original page');
  const zoomBefore = window.webContents.getZoomFactor();
  try {
    for (const factor of [0.75, 1.25, 1]) {
      window.webContents.setZoomFactor(factor);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const layout = await evaluate(`(() => {
        const chat = [...document.querySelectorAll('.conversation')].find(el => el.getClientRects().length);
        const transcript = chat.querySelector('.transcript');
        const last = [...transcript.children].filter(el => el.getClientRects().length && getComputedStyle(el).display !== 'none').at(-1);
        return { gap: chat.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom, padding: parseFloat(getComputedStyle(transcript).paddingBottom) };
      })()`);
      if (Math.abs(layout.gap - layout.padding) > 3) throw new Error(`Zoom ${factor} left a chat gap: ${JSON.stringify(layout)}`);
    }
    report.checks.push('Zooming out, in, and resetting keeps the latest chat content beside the composer without an expanding blank gap');
  } finally { window.webContents.setZoomFactor(zoomBefore); }
  // The background chat has no guest yet; the foreground chat already has one.
  const callBeforeCreation = bridge.rawCall;
  const createdReplies = [];
  bridge.rawCall = function(method, params) {
    if (method === 'browser.openResult' && params.invocationId === 'smoke-background-create') { createdReplies.push(params); return Promise.resolve({ accepted: true }); }
    return callBeforeCreation.call(this, method, params);
  };
  try {
    bridge.browserOpener.handleOpen({ invocationId: 'smoke-background-create', workspaceId: state.workspaceId, sessionId: other.id, leaseMs: 15_000 });
    for (const deadline = Date.now() + 15_000; !createdReplies.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 30));
    const reply = createdReplies[0];
    const createdHost = [...bridge.agent.hosts.values()].find(host => host.capabilityId === reply?.capabilityId);
    if (!createdHost || reply.error || createdHost.guest.id === guestId) throw new Error(`new background tab reused the foreground guest: ${JSON.stringify(reply)}`);
    if (await evaluate('window.__joloSmoke.state().sessionId') !== state.sessionId) throw new Error('background creation switched chats');
    await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(other.id)})`);
    await waitFor(`(() => { try { return document.querySelector('.browser-host .panel-item-content:not([hidden]) webview')?.getWebContentsId() === ${createdHost.guest.id}; } catch { return false; } })()`, 'new browser belongs to the background chat');
    await evaluate("document.querySelector('.inspector:not([hidden]) .panel-item-tab[data-active=true] .panel-item-close').click()");
    await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(state.sessionId)})`);
    await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(state.sessionId)}`, 'return to original chat');
    report.checks.push('Opening a new tab for a background chat in the same workspace creates its own guest and displays it only in that chat');
  } finally { bridge.rawCall = callBeforeCreation; }
  report.checks.push('Chat alone opened the closed inline browser, navigated, snapshotted, clicked a real element, and captured a screenshot through the engine broker');
}

/**
 * Computer use against the real Chromium guest: a screenshot fixes the coordinate space, a pointer
 * click at the button's screenshot pixels reaches the page, and zoom returns a region image. The
 * host is driven directly, as the approval smoke does, so no model has to guess coordinates.
 */
async function runComputerUseSmoke({ bridge, guest, report }) {
  await guest.executeJavaScript("document.querySelector('button').textContent = 'Click'");
  const host = [...bridge.agent.hosts.values()].find(entry => entry.guest === guest);
  const rawCall = bridge.rawCall;
  const replies = [];
  bridge.rawCall = function(method, params) {
    if (method === 'browser.result' && String(params.invocationId).startsWith('smoke-cu-')) { replies.push(params); return Promise.resolve({ accepted: true }); }
    return rawCall.call(this, method, params);
  };
  const run = async (operation, args) => {
    await bridge.agent.handleExecute({ invocationId: `smoke-cu-${operation}-${replies.length}`, capabilityId: host.capabilityId, navigationRevision: host.navigationRevision, operation, arguments: args, leaseMs: 10_000 });
    const reply = replies.at(-1);
    if (reply?.status !== 'ok') throw new Error(`computer-use ${operation} failed: ${JSON.stringify(reply)}`);
    return reply;
  };
  try {
    const shot = await run('screenshot', {});
    if (!shot.screenshot?.base64 || !(shot.result.scale > 0)) throw new Error(`screenshot lacks image or scale: ${JSON.stringify(shot.result)}`);
    const centre = await guest.executeJavaScript("(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    const x = Math.round(centre.x * shot.result.scale), y = Math.round(centre.y * shot.result.scale);
    await run('pointer', { action: 'click', x, y, modifiers: [] });
    let text;
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      text = await guest.executeJavaScript("document.querySelector('button').textContent");
      if (text === 'Clicked') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (text !== 'Clicked') throw new Error(`pointer click at screenshot (${x}, ${y}) did not reach the page: ${text}`);
    const zoom = await run('zoom', { x0: 0, y0: 0, x1: Math.max(2, x * 2), y1: Math.max(2, y * 2) });
    if (!zoom.screenshot?.base64 || zoom.screenshot.width < 1) throw new Error(`zoom returned no region image: ${JSON.stringify(zoom.result)}`);
    report.checks.push('Computer use: a screenshot fixed the coordinate space, a pointer click at screenshot pixels reached the real page, and zoom returned a region image');
  } finally { bridge.rawCall = rawCall; }
}

export async function runBrowserContentionSmoke({ bridge, browserHost, project, evaluate, waitFor, report }) {
  const original = [...browserHost.guests.values()][0].guest;
  const url = original.getURL();
  const originalWorkspace = await evaluate('window.__joloSmoke.state().workspaceId');
  const otherProject = path.join(path.dirname(project), 'other-browser-workspace');
  mkdirSync(otherProject, { recursive: true });
  const paneId = await evaluate('window.__joloSmoke.split()');
  try {
    await waitFor(`window.__joloSmoke.layout().active === ${JSON.stringify(paneId)} && window.__joloSmoke.state().projectId`, 'second pane ready');
    await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(otherProject)})`);
    await waitFor(`window.__joloSmoke.state().workspaceId && window.__joloSmoke.state().workspaceId !== ${JSON.stringify(originalWorkspace)}`, 'other workspace ready');
    await evaluate("window.__joloSmoke.send('Open the inline browser in this workspace.')");
    await waitFor("['completed','failed','paused'].includes(window.__joloSmoke.state().runState)", 'competing browser run finished');
    const state = await evaluate('window.__joloSmoke.state()');
    if (state.runState !== 'completed' || !state.toolText.includes('browser_open') || state.toolText.includes('"code":"conflict"')) throw new Error(`second workspace browser did not open: ${state.toolText.slice(0, 1200)}`);
    if (original.isDestroyed() || browserHost.guests.size !== 2 || original.getURL() !== url) throw new Error('second chat replaced the first browser');
    if (await original.executeJavaScript("document.querySelector('button').textContent") !== 'Clicked') throw new Error('competing chat changed the first browser page');
    report.checks.push('Two workspace chats opened independent browsers while preserving the first guest, URL and page state');
    await evaluate('window.__joloSmoke.closeBrowser()');
    const { session: background } = await bridge.rawCall('session.create', { projectId: state.projectId, workspaceId: state.workspaceId, title: 'Background browser task' });
    await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(background.id)})`);
    await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(background.id)}`, 'background task scope initialized');
    const thirdProject = path.join(path.dirname(project), 'active-browser-workspace');
    mkdirSync(thirdProject, { recursive: true });
    await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(thirdProject)})`);
    await waitFor(`window.__joloSmoke.state().workspaceId && window.__joloSmoke.state().workspaceId !== ${JSON.stringify(state.workspaceId)}`, 'switch away before browser opens');
    const activeWorkspace = await evaluate('window.__joloSmoke.state().workspaceId');
    const { run } = await bridge.rawCall('run.start', { sessionId: background.id, requestId: 'background-browser', prompt: 'Open the inline browser and click the test button.' });
    const deadline = Date.now() + 15_000;
    let result;
    do {
      result = (await bridge.rawCall('run.snapshot', { runId: run.id })).run;
      if (['completed', 'failed', 'paused'].includes(result.state)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    if (result.state !== 'completed') throw new Error(`background browser run ${result.state}: ${result.failure}`);
    if (await evaluate('window.__joloSmoke.state().workspaceId') !== activeWorkspace) throw new Error('background browser opening changed the active workspace');
    if (original.isDestroyed() || original.getURL() !== url) throw new Error('background browser opening replaced the original guest');
    const backgroundHost = [...bridge.agent.hosts.values()].find(host => host.workspaceId === state.workspaceId);
    if (!backgroundHost || await backgroundHost.guest.executeJavaScript("document.querySelector('button').textContent") !== 'Clicked') throw new Error('background workspace browser did not complete its click');
    report.checks.push('A background task opened and operated its own browser after switching workspaces, without taking focus or replacing another guest');
    await evaluate(`window.__joloSmoke.openProject(${JSON.stringify(otherProject)})`);
    await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(background.id)})`);
    await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(background.id)} && document.querySelector('[data-pane-id="${paneId}"] .inspector').hidden`, 'background task browser is closed on returning to its chat');
    if (await evaluate(`document.querySelector('[data-pane-id="pane-1"] .inspector').hidden`)) throw new Error('background completion hid another chat browser');
    report.checks.push('Background completion closes only its own browser panel, including when returning to that chat');
    await evaluate("window.__joloSmoke.zoomPane('pane-1')");
    await waitFor(`document.querySelector('[data-pane-id="${paneId}"]').hidden`, 'background pane hidden by maximized pane');
    await runComputerUseSmoke({ bridge, guest: backgroundHost.guest, report });
    report.checks.push('A retained browser still accepts pointer input and screenshots while its entire workspace pane is hidden');
  } finally { await evaluate(`window.__joloSmoke.closePane(${JSON.stringify(paneId)})`); }
}
