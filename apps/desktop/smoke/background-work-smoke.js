import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectPanel } from './panel-controls.js';

/**
 * Claude's background work and its questions to the person, against the fake Claude: two background tasks are listed
 * in the Activity panel and stopped from it, then an AskUserQuestion and an ExitPlanMode are answered from dialog cards,
 * then two tasks that ignore Stop background work are ended by Force stop (closing the process after a confirmation),
 * and a workflow names the activity line with its phase and agents, shows as one card with its agent count and its phase
 * with a square per agent, and is stopped. Clear finished hides the first two tasks once they stopped.
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
  const words = element => `[...${element}.children].map(item => item.textContent).join(' ')`;
  const line = "document.querySelector('.activity-line .activity-line-text')?.textContent";

  await evaluate("window.__joloSmoke.pickAnswerer('claude')");
  await waitFor("window.__joloSmoke.state().answerer === 'Claude Code'", 'composer shows Claude Code as the answerer');
  await send('tasks 2 20000');
  await waitFor("document.querySelector('.activity-line')?.textContent.includes('Background work: 2 tasks')", 'the activity line counts two background tasks', 20_000);
  await completed('the turn that started the tasks completed');
  await selectPanel(evaluate, waitFor, 'Activity');
  await waitFor(`${rows}.length === 2`, 'the Activity panel lists both tasks');
  assert.deepEqual(await evaluate(`${rows}.map(row => row.dataset.state)`), ['running', 'running']);
  // The panel's rows leave the sidebar's own task rows, which share the task-row class, as they were: one line, no divider.
  const sidebarRow = "document.querySelector('.sidebar-chat-row.task-row')";
  await waitFor(`Boolean(${sidebarRow})`, 'the sidebar lists the conversation as a task row');
  assert.deepEqual(await evaluate(`(() => { const style = getComputedStyle(${sidebarRow}); return { display: style.display, padding: style.paddingTop, border: style.borderBottomWidth, short: ${sidebarRow}.getBoundingClientRect().height < 36 }; })()`),
    { display: 'block', padding: '0px', border: '0px', short: true });
  await screenshot('background-work.png');
  await evaluate(`${button('.activity-panel .activity-heading', 'Stop background work')}.click()`);
  await waitFor(`!document.querySelector('.activity-line') && ${rows}.length === 2 && ${rows}.every(row => row.dataset.state === 'stopped' && row.querySelector('.activity-task-meta').textContent.includes('Stopped') && row.closest('.finished-tasks'))`, 'Stop background work stopped both tasks, listed under Finished 2', 20_000);
  assert.equal(await evaluate("document.querySelector('.activity-panel .finished-tasks > summary').textContent"), 'Finished 2');
  await screenshot('finished.png');
  // Clear finished hides both: nothing runs, so the panel is empty again.
  await evaluate("document.querySelector('.activity-panel .activity-heading button[aria-label=\"Clear finished\"]').click()");
  await waitFor(`${rows}.length === 0 && !document.querySelector('.activity-panel .finished-tasks') && document.querySelector('.activity-panel .activity-heading').textContent.includes('Nothing running')`, 'Clear finished removed both stopped rows');

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

  // Tasks that ignore stop_task: the stop leaves them running and offers Force stop, which closes Claude's process after a
  // confirmation; the tasks end with it and read failed.
  await send('tasks-stubborn 2');
  await waitFor(`${line}?.includes('Background work: 2 tasks')`, 'the activity line counts two stubborn tasks', 20_000);
  await completed('the turn that started the stubborn tasks completed');
  await selectPanel(evaluate, waitFor, 'Activity');
  await waitFor(`${rows}.length === 2 && ${rows}.every(row => row.dataset.state === 'running')`, 'the Activity panel lists both stubborn tasks running');
  await evaluate(`${button('.activity-line', 'Stop background work')}.click()`);
  const forceStop = button('.activity-panel .panel-note', 'Force stop');
  await waitFor(`document.querySelector('.activity-panel .panel-note')?.textContent.includes('Some tasks did not stop') && Boolean(${forceStop})`, 'a stop the tasks ignored offers Force stop', 20_000);
  await evaluate(`${forceStop}.click()`);
  const confirm = `[...document.querySelectorAll('dialog.modal[open]')].find(item => item.getAttribute('aria-label') === ${JSON.stringify("Close Claude's process?")})`;
  await waitFor(`Boolean(${confirm}) && [...${confirm}.querySelectorAll('button')].some(item => item.textContent === 'Close process')`, 'Force stop asks before closing the process');
  await screenshot('force-stop.png');
  await evaluate(`[...${confirm}.querySelectorAll('button')].find(item => item.textContent === 'Close process').click()`);
  await waitFor(`!document.querySelector('.activity-line') && ${rows}.length === 2 && ${rows}.every(row => row.dataset.state === 'failed' && row.querySelector('.activity-task-meta').textContent.includes('Failed'))`, 'closing the process ended both tasks, which read failed', 20_000);
  await waitFor('!document.querySelector("dialog.modal[open]")', 'the confirmation closed');

  // A workflow is one task: it names the line with its phase and finished agents from Claude's progress report, shows as
  // one card titled with its name, its two agents and its one phase with a square per agent, and Stop background work
  // ends it.
  await send('workflow demo 20000');
  await waitFor(`/^Workflow demo: Say [0-2]\\/2 · /.test(${line} ?? '') && !${line}.includes(' 0 tokens')`, 'the activity line names the workflow, its phase and its finished agents, and no 0 tokens', 20_000);
  await completed('the turn that started the workflow completed');
  await selectPanel(evaluate, waitFor, 'Activity');
  const card = "document.querySelector('.activity-panel .workflow-card')";
  const metas = `[...${card}.querySelectorAll('.card-meta')]`;
  const phase = `${card}.querySelector('.workflow-phase')`;
  const squares = `[...${phase}.querySelectorAll('.phase-squares span')].map(item => item.dataset.status)`;
  await waitFor(`document.querySelectorAll('.activity-panel .workflow-card').length === 1 && !${card}.closest('.finished-tasks') && ${card}.querySelector('.workflow-title').textContent === 'demo' && ${words(`${metas}[0]`)} === 'Workflow Running'`, 'the Activity panel shows one running workflow card titled demo');
  await waitFor(`${metas}[1]?.firstChild.textContent === '2 agents' && !${card}.textContent.includes(' 0 tokens') && ${card}.querySelectorAll('.workflow-phase').length === 1 && ${words(`${phase}.querySelector('.phase-head')`)} === 'Say 0/2' && ${squares}.join() === 'running,running'`, 'the workflow card shows its two agents, its phase Say 0/2 with two running squares, and no 0 tokens');
  await screenshot('workflow.png');
  await evaluate(`${button('.activity-panel .activity-heading', 'Stop background work')}.click()`);
  await waitFor(`!document.querySelector('.activity-line') && ${card}?.dataset.state === 'stopped' && ${words(`${metas}[0]`)} === 'Workflow Stopped' && !${card}.querySelector('button') && Boolean(${card}.closest('.finished-tasks'))`, 'Stop background work ended the workflow, listed among the finished', 20_000);
  // Its last report still lists its agents as started: their squares read stopped, as the workflow does, never running
  // (one that finished before the stop reads done).
  const done = Number(await evaluate(`${phase}.querySelector('.phase-head').lastChild.textContent.split('/')[0]`));
  assert.deepEqual(await evaluate(squares), [...Array(done).fill('done'), ...Array(2 - done).fill('stopped')]);
  assert.ok(done < 2, 'the workflow was stopped before both agents were done');

  report.checks.push('background work is listed and stopped from the Activity panel, the stopped tasks under Finished 2, which Clear finished hides, the task rows of the sidebar left as they were; AskUserQuestion and ExitPlanMode are answered from dialog cards; tasks that ignore Stop background work are ended by Force stop after the Close process confirmation and read Failed; a workflow names the activity line with its phase and finished agents, shows as one card titled with its name, its two agents and its phase Say 0/2 with a square per agent, and Stop background work ends it, its squares reading stopped');
}
