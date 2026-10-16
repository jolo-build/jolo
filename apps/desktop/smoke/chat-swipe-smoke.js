import { writeFile } from 'node:fs/promises';

export async function runChatSwipeSmoke({ window, bridge, evaluate, waitFor, report }) {
  window.webContents.setBackgroundThrottling(false);
  const original = await evaluate('window.__joloSmoke.state()');
  // Create chats without visiting them: swipes must include the entire rail.
  for (const title of ['Swipe first', 'Swipe second']) {
    await bridge.rawCall('session.create', { projectId: original.projectId, workspaceId: original.workspaceId, title });
  }
  await bridge.rawCall('chat.create', {});
  await evaluate('window.__joloSmoke.showBoard()');
  await evaluate('window.__joloSmoke.showTask()');
  await evaluate("document.querySelector('[aria-label=\"Hide sidebar\"]')?.click()");
  await waitFor("document.querySelectorAll('.task-rail [data-task-id]').length >= 3", 'all chats loaded into rail');
  const chats = await evaluate("[...document.querySelectorAll('.task-rail [data-task-id]')].slice(0, 3).map(button => button.dataset.taskId)");
  await evaluate(`document.querySelector('.task-rail [data-task-id="${chats[2]}"]').click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(chats[2])}`, 'start at third rail chat');
  const naturalScrolling = await evaluate('window.jolo.naturalScrolling');
  const deltaFor = direction => naturalScrolling ? -direction : direction;
  const gesture = async (deltaX, extra = {}, selector = '.conversation') => {
    await evaluate('new Promise(resolve => setTimeout(resolve, 350))');
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, deltaX: ${deltaFor(deltaX)}, ...${JSON.stringify(extra)} }))`);
  };
  const selected = async id => waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(id)}`, 'swipe selected expected chat');
  await evaluate("window.__swipeOuterScrollbars = []; window.__swipeObserveFrames = true; (() => { const sample = () => { if (!window.__swipeObserveFrames) return; const main = document.querySelector('main[aria-label=\"Conversation\"]'); if (main) { const style = getComputedStyle(main); if (style.overflowX !== 'hidden' || style.overflowY !== 'hidden') window.__swipeOuterScrollbars.push([style.overflowX, style.overflowY]); } requestAnimationFrame(sample); }; sample(); })()");
  await evaluate("window.__swipePreviewHold = setInterval(() => document.querySelector('.conversation').dispatchEvent(new WheelEvent('wheel', { bubbles:true, deltaX:window.jolo.naturalScrolling ? .01 : -.01 })), 100)");
  await gesture(-30);
  await waitFor("Boolean(document.querySelector('.chat-swipe-hint.previous svg path')) && Boolean(document.querySelector('.chat-swipe-destination strong')?.textContent)", 'destination preview appears before navigation');
  if (await evaluate('window.__joloSmoke.state().sessionId') !== chats[2]) throw new Error('partial swipe navigated too early');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile('/tmp/jolo-chat-swipe-preview.json', JSON.stringify(await evaluate("(() => { const hint = document.querySelector('.chat-swipe-hint'); const rect = hint.getBoundingClientRect(); return {rect:rect.toJSON(), opacity:getComputedStyle(hint).opacity, text:hint.textContent}; })()")));
  try { await writeFile('/tmp/jolo-chat-swipe-preview.png', (await window.webContents.capturePage()).toPNG()); }
  finally { await evaluate('clearInterval(window.__swipePreviewHold)'); }
  await waitFor("!document.querySelector('.chat-swipe-hint')", 'arrow clears when swipe stops');
  await gesture(-100); await selected(chats[1]);
  // Momentum belongs to the first gesture, even though the chat already changed.
  await evaluate("document.querySelector('.conversation').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: window.jolo.naturalScrolling ? 200 : -200 }))");
  if (await evaluate('window.__joloSmoke.state().sessionId') !== chats[1]) throw new Error('momentum skipped a chat');
  await evaluate("window.__swipeNextHold = setInterval(() => document.querySelector('.conversation').dispatchEvent(new WheelEvent('wheel', { bubbles:true, deltaX:window.jolo.naturalScrolling ? -.01 : .01 })), 100)");
  await gesture(30);
  await waitFor("Boolean(document.querySelector('.chat-swipe-hint.next svg path'))", 'next-chat arrow appears');
  await evaluate('clearInterval(window.__swipeNextHold)');
  await waitFor("!document.querySelector('.chat-swipe-hint')", 'next arrow clears');
  report.checks.push('Destination previews show a direction, chat title and progress during swipes, then disappear');
  // A slow sidebar listing must not block a known chat in another project.
  const originalCall = bridge.call;
  let releaseLists = () => {};
  const listsGate = new Promise(resolve => { releaseLists = () => resolve(null); });
  bridge.call = async function(method, params) {
    if (method === 'session.list' || method === 'workspace.list') await listsGate;
    return originalCall.call(this, method, params);
  };
  try { await gesture(-100); await selected(chats[0]); }
  finally { releaseLists(); bridge.call = originalCall; }
  report.checks.push('Cross-project swipes open the target without waiting for sidebar/workspace lists');
  await gesture(100); await selected(chats[1]);
  await gesture(100); await selected(chats[2]);
  // A trackpad can reverse without the idle gap used by separate gestures.
  await evaluate("document.querySelector('.conversation').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: window.jolo.naturalScrolling ? -5000 : 5000 }))");
  await evaluate("document.querySelector('.conversation').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: window.jolo.naturalScrolling ? 100 : -100 }))");
  await selected(chats[1]);
  await gesture(100); await selected(chats[2]);
  report.checks.push('Two-finger wheel gestures navigate backward/forward across workspace and standalone chats, including unvisited chats in rail order and a quick reversal after momentum');
  await gesture(-100, {}, '.header'); await selected(chats[1]);
  await evaluate("document.querySelector('[aria-label=\"Show sidebar\"]')?.click()");
  await gesture(100, {}, '.sidebar'); await selected(chats[2]);
  await gesture(-100, {}, '.composer textarea'); await selected(chats[1]);
  await gesture(100, {}, '.header'); await selected(chats[2]);
  report.checks.push('Swipes over the header, sidebar and empty message box navigate the active chat');
  const outerScrollbars = await evaluate('window.__swipeObserveFrames = false; window.__swipeOuterScrollbars');
  if (outerScrollbars.length) throw new Error('chat switches enabled a second outer scrollbar');
  report.checks.push('Chat layout keeps a single transcript scroller during swipe transitions');
  await gesture(-100, { deltaY: 200 });
  await gesture(-100, { ctrlKey: true });
  await evaluate("(() => { const child = document.createElement('div'); child.id = 'swipe-scroll-test'; child.style.cssText = 'width:100px;overflow-x:auto'; child.innerHTML = '<div style=\"width:800px\">Horizontal code</div>'; document.querySelector('.conversation').append(child); })()");
  await gesture(-100, {}, '#swipe-scroll-test');
  await evaluate("document.getElementById('swipe-scroll-test').remove()");
  await evaluate("(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Keep this draft'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await waitFor('document.querySelector(\'.composer\').dataset.hasDraft === "true"', 'draft marked as unsent');
  await gesture(-100);
  if (await evaluate('window.__joloSmoke.state().sessionId') !== chats[2]) throw new Error('protected gesture switched chats');
  if (await evaluate("document.querySelector('.composer textarea').value") !== 'Keep this draft') throw new Error('swipe lost draft');
  await evaluate("(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await waitFor('document.querySelector(\'.composer\').dataset.hasDraft === "false"', 'draft cleared');
  await evaluate('new Promise(resolve => setTimeout(resolve, 350))');
  const point = await evaluate("(() => { const rect = document.querySelector('.conversation').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()");
  window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: -deltaFor(-120), deltaY: 0 });
  await selected(chats[1]);
  report.checks.push('Native horizontal wheel input also navigates the chat history');
  // Leave the cursor in the middle of history. A reload must restore this chat,
  // not silently select the newest task and discard the forward branch.
  await waitFor(`(() => { const saved = JSON.parse(sessionStorage.getItem('jolo.chatNavigation.v1')); return saved.entries[saved.index].session.id === ${JSON.stringify(chats[1])}; })()`, 'selected chat saved');
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload(); await loaded;
  await waitFor(`Boolean(window.__joloSmoke) && window.__joloSmoke.state().sessionId === ${JSON.stringify(chats[1])}`, 'reload restored the selected chat');
  await evaluate('window.__joloSmoke.showTask()');
  await gesture(100, {}, '.header'); await selected(chats[2]);
  await gesture(-100, {}, '.header'); await selected(chats[1]);
  report.checks.push('Reload preserves the selected chat and navigation in rail order');
  // New native gesture boundaries rearm immediately, even with no idle timeout.
  for (const [direction, id] of [[-1, chats[0]], [1, chats[1]], [1, chats[2]]]) {
    window.webContents.emit('input-event', {}, { type: 'gestureScrollBegin' });
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    await evaluate(`document.querySelector('.conversation').dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaX:${deltaFor(Number(direction) * 40)} }))`);
    await selected(id);
  }
  report.checks.push('Consecutive native swipe starts navigate without waiting for the previous gesture to settle');
  report.checks.push('Vertical scrolling, pinch zoom, horizontally scrollable content, and unsent drafts do not switch chats');
}
