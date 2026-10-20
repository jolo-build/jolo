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
  // The child is not a row of the sidebar; the parent's header lists it.
  const child = JSON.stringify(`[data-session-id="${delegations[0].sessionId}"]`);
  const parentRow = JSON.stringify(`.sidebar [data-session-id="${parent}"]`);
  const toggle = "document.querySelector('.task-header .child-tasks-toggle')";
  const painted = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
  await waitFor(`Boolean(document.querySelector(${parentRow})) && ${toggle}?.textContent.includes('1 child task')`, 'the parent lists its child task in its header');
  assert.equal(await evaluate(`Boolean(document.querySelector('.sidebar ' + ${child}))`), false, 'the child is not a row of the sidebar');
  await evaluate(`${toggle}.click()`);
  await waitFor(`Boolean(document.querySelector('.child-tasks-menu:popover-open ' + ${child}))`, 'the header lists the child task');
  await evaluate(painted);
  writeFileSync(path.join(results, 'delegation-result.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('.child-tasks-menu ' + ${child}).click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(delegations[0].sessionId)}`, 'child opens its own conversation');
  await waitFor("window.__joloSmoke.state().assistantText.includes('fake-large')", 'child transcript loaded');
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'), /fake-large.*high/);
  await waitFor("Boolean(document.querySelector('.task-header .parent-task-link'))", 'the child offers the way back to its parent');
  await evaluate("document.querySelector('.task-header .parent-task-link').click()");
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(parent)}`, 'parent opens again');
  report.checks.push('Model mention search, effort selection, removable chips, unchanged parent model, real scoped MCP child execution, result collection, child tasks listed in the header of their parent, and opening the child and returning to the parent passed.');
}
