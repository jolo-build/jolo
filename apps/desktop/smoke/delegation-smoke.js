import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runDelegationSmoke({ window, bridge, evaluate, waitFor, report, results }) {
  const type = async value => {
    await evaluate("(() => {const input=document.querySelector('.composer textarea');input.focus();input.select();})()");
    await window.webContents.insertText(value);
  };
  const key = key => evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
  await evaluate("window.__joloSmoke.pickAnswerer('codex')");
  await waitFor("window.__joloSmoke.state().answerer === 'Codex'", 'parent agent selected');
  await type('delegation-check ^fake-large~high');
  try { await waitFor("document.querySelector('.mention-list [role=option]')?.textContent.includes('Fake Large')", 'model mention results'); }
  catch (error) {
    writeFileSync(path.join(results, 'delegation-picker-failure.png'), (await window.webContents.capturePage()).toPNG());
    throw new Error(`${error.message}; composer=${await evaluate("JSON.stringify({text:document.querySelector('.composer').innerText,html:document.querySelector('.composer textarea').outerHTML,selection:document.querySelector('.composer textarea').selectionStart,active:document.activeElement?.tagName})")}`);
  }
  assert(await evaluate("document.querySelector('.mention-list').textContent.includes('high')"));
  assert.equal(await evaluate('window.__joloSmoke.state().runCount'), 0);
  assert(await evaluate("(() => {const r=document.querySelector('.mention-list').getBoundingClientRect();return r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()"));
  writeFileSync(path.join(results, 'delegation-picker.png'), (await window.webContents.capturePage()).toPNG());
  await key('Enter');
  await waitFor("document.querySelector('.delegation-chip')?.textContent.includes('Fake Large')", 'selected model chip');
  assert.equal(await evaluate('window.__joloSmoke.state().runCount'), 0, 'selection must not submit');
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"), 'delegation-check ^agent:codex/fake-large~high ');
  await evaluate("document.querySelector('.delegation-chip button').click()");
  await waitFor("!document.querySelector('.delegation-chip')", 'chip removes the mention');
  await type('delegation-check ^fake-large~high');
  await waitFor("Boolean(document.querySelector('.mention-list [role=option]'))", 'picker reopens');
  await key('Enter');
  await evaluate("document.querySelector('.composer-submit').click()");
  await waitFor("window.__joloSmoke.state().runState === 'completed'", 'parent collects child result', 30_000);
  const parent = await evaluate('window.__joloSmoke.state().sessionId');
  const { delegations } = await bridge.rawCall('delegation.list', { sessionId: parent });
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0].execution.model, 'fake-large');
  assert.equal(delegations[0].execution.effort, 'high');
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'), /Child result:.*fake-large.*high/);
  // The child is listed under its parent in the sidebar, not beside it, until the parent's count folds it.
  const child = JSON.stringify(`[data-session-id="${delegations[0].sessionId}"]`);
  const parentRow = JSON.stringify(`.sidebar-chat-row.has-subtasks [data-session-id="${parent}"]`);
  const count = "document.querySelector('.sidebar-chat-row.has-subtasks .task-subtasks')";
  const childShown = `Boolean(document.querySelector('.sidebar-subtasks ' + ${child}))`;
  const painted = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
  await waitFor(`Boolean(document.querySelector(${parentRow})) && ${count}?.textContent.includes('1') && ${childShown}`, 'child shown under its parent');
  assert.equal(await evaluate(`Boolean(document.querySelector('.sidebar-workspace-chats > .task-row ' + ${child}))`), false, 'the child is not a task of its own in the sidebar');
  await evaluate(painted);
  writeFileSync(path.join(results, 'delegation-result.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('.sidebar-subtasks ' + ${child}).click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(delegations[0].sessionId)}`, 'child opens its own conversation');
  await waitFor("window.__joloSmoke.state().assistantText.includes('fake-large')", 'child transcript loaded');
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'), /fake-large.*high/);
  await evaluate(`document.querySelector(${parentRow}).click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(parent)}`, 'parent opens again');
  await evaluate(painted);
  assert.equal(await evaluate(childShown), true, 'opening the parent leaves its child tasks listed');
  await evaluate(`${count}.click()`);
  await waitFor(`!${childShown}`, 'the count folds the child tasks');
  await evaluate(`${count}.click()`);
  await waitFor(childShown, 'the count lists them again');
  report.checks.push('Model mention search, effort selection, removable chips, unchanged parent model, real scoped MCP child execution, result collection, child tasks listed under their parent, and opening the child conversation passed.');
}
