import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectPanel } from './panel-controls.js';

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
  // The child is not a row of the sidebar, nor in the parent's header; the Activity panel lists it under Child tasks.
  const child = JSON.stringify(`[data-session-id="${delegations[0].sessionId}"]`);
  const parentRow = JSON.stringify(`.sidebar [data-session-id="${parent}"]`);
  const row = `document.querySelector('.activity-panel .child-tasks ' + ${child})`;
  const painted = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
  await waitFor(`Boolean(document.querySelector(${parentRow}))`, 'the parent is a row of the sidebar');
  assert.equal(await evaluate(`Boolean(document.querySelector('.sidebar ' + ${child}))`), false, 'the child is not a row of the sidebar');
  assert.equal(await evaluate("Boolean(document.querySelector('.task-header .child-tasks-toggle, .child-tasks-menu'))"), false, 'the header no longer lists child tasks');
  await selectPanel(evaluate, waitFor, 'Activity');
  await waitFor(`document.querySelector('.activity-panel .child-tasks .activity-section-label')?.textContent === 'Child tasks' && Boolean(${row}) && ${row}.dataset.state === 'done' && ${row}.querySelector('.child-task-open').title.startsWith('Open ') && /^Child · /.test(${row}.querySelector('.activity-task-meta').textContent) && !${row}.querySelector('.stop-task')`, 'the Activity panel lists the finished child task under Child tasks, with no stop', 20_000);
  await waitFor(`/Answered/.test(${row}.querySelector('.activity-task-meta').textContent)`, 'the child row says the child answered, from its delegation row');
  await evaluate(painted);
  writeFileSync(path.join(results, 'delegation-result.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`${row}.querySelector('.child-task-open').click()`);
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(delegations[0].sessionId)}`, 'child opens its own conversation');
  await waitFor("window.__joloSmoke.state().assistantText.includes('fake-large')", 'child transcript loaded');
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'), /fake-large.*high/);
  await waitFor("Boolean(document.querySelector('.task-header .parent-task-link'))", 'the child offers the way back to its parent');
  await evaluate("document.querySelector('.task-header .parent-task-link').click()");
  await waitFor(`window.__joloSmoke.state().sessionId === ${JSON.stringify(parent)}`, 'parent opens again');
  report.checks.push('Model mention search, effort selection, removable chips, unchanged parent model, real scoped MCP child execution, result collection, child tasks listed in the Activity panel of their parent (not in its header), and opening the child from there and returning to the parent passed.');
}
