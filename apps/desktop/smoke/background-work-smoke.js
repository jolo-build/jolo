import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectPanel } from './panel-controls.js';

/**
 * Claude's background work and its questions to the person, against the fake Claude: two background tasks are listed
 * in the Activity panel and stopped from it, then an AskUserQuestion and an ExitPlanMode are answered from dialog cards.
 */
export async function runBackgroundWorkSmoke({ window, bridge, evaluate, waitFor, report, results }) {
  const send = async value => {
    await evaluate("(() => {const input=document.querySelector('.composer textarea');input.focus();input.select();})()");
    await window.webContents.insertText(value);
    await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
  };
  const painted = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
  const screenshot = async name => {
    await evaluate(painted);
    writeFileSync(path.join(results, name), (await window.webContents.capturePage()).toPNG());
  };
  const completed = label => waitFor("window.__joloSmoke.state().runState === 'completed'", label, 30_000);
  const button = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(item => item.textContent === ${JSON.stringify(text)})`;
  const rows = "[...document.querySelectorAll('.activity-panel .task-row')]";

  await evaluate("window.__joloSmoke.pickAnswerer('claude')");
  await waitFor("window.__joloSmoke.state().answerer === 'Claude Code'", 'composer shows Claude Code as the answerer');
  await send('tasks 2 20000');
  await waitFor("document.querySelector('.activity-line')?.textContent.includes('Background work: 2 tasks')", 'the activity line counts two background tasks', 20_000);
  await completed('the turn that started the tasks completed');
  await selectPanel(evaluate, waitFor, 'Activity');
  await waitFor(`${rows}.length === 2`, 'the Activity panel lists both tasks');
  assert.deepEqual(await evaluate(`${rows}.map(row => row.dataset.state)`), ['running', 'running']);
  await screenshot('background-work.png');
  await evaluate(`${button('.activity-panel .activity-heading', 'Stop background work')}.click()`);
  await waitFor(`!document.querySelector('.activity-line') && ${rows}.length === 2 && ${rows}.every(row => row.dataset.state === 'stopped' && row.querySelector('.activity-task-meta').textContent.includes('stopped'))`, 'Stop background work stopped both tasks', 20_000);

  await send('ask-user tea or coffee?');
  await waitFor("Boolean(document.querySelector('dialog.dialog-modal[open]'))", 'the question opens as a dialog card', 20_000);
  const coffee = "[...document.querySelectorAll('dialog.dialog-modal[open] label.dialog-option')].find(label => label.textContent === 'coffee')?.querySelector('input[type=radio]')";
  await waitFor(`Boolean(${coffee})`, 'the question offers coffee');
  await evaluate(`${coffee}.click()`);
  await waitFor(`${coffee}.checked && !${button('dialog.dialog-modal[open]', 'Answer')}?.disabled`, 'picking coffee enables Answer');
  await screenshot('dialog-question.png');
  await evaluate(`${button('dialog.dialog-modal[open]', 'Answer')}.click()`);
  await waitFor("window.__joloSmoke.state().assistantText.includes('You answered: coffee')", 'Claude read the answer', 20_000);
  await waitFor("!document.querySelector('dialog.dialog-modal[open]')", 'the question card closed');
  await completed('the question turn completed');

  await send('exit-plan Ship it');
  await waitFor(`Boolean(${button('dialog.dialog-modal[open]', 'Approve plan')})`, 'the plan opens as a dialog card', 20_000);
  assert.match(await evaluate("document.querySelector('dialog.dialog-modal[open] .plan-body').textContent"), /Ship it/);
  await screenshot('dialog-plan.png');
  await evaluate(`${button('dialog.dialog-modal[open]', 'Approve plan')}.click()`);
  await waitFor("window.__joloSmoke.state().assistantText.includes('Plan approved: Ship it')", 'Claude read the approval', 20_000);
  await waitFor("!document.querySelector('dialog.dialog-modal[open]')", 'the plan card closed');
  await completed('the plan turn completed');

  report.checks.push('background work is listed and stopped from the Activity panel; AskUserQuestion and ExitPlanMode are answered from dialog cards');
}
