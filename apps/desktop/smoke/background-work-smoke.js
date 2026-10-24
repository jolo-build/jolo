import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { hidePanel, selectPanel } from './panel-controls.js';

/**
 * Claude's background work and its questions to the person, against the fake Claude: two background tasks are listed
 * in the Activity panel, one stopped by its own stop square and the other by Stop background work, then an
 * AskUserQuestion and an ExitPlanMode are answered from dialog cards, then two tasks that ignore Stop background work are
 * ended by Force stop (closing the process after a confirmation), and a workflow names the activity line with its phase
 * and agents, shows in the chat as a compact card where Claude called the Workflow tool, whose head opens the Activity
 * panel, and there as one card with its agent count and its phase with a square per agent, whose chevron opens one line
 * per agent, and is stopped; a second workflow completes, and its card shows Claude's summary and its output file, its
 * chat card Completed. Clear finished hides the first two tasks once they stopped.
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
  // One task stops by the square at the top right of its row, named after it: it moves under Finished, the other runs on.
  const first = await evaluate(`${rows}[0].querySelector('.activity-task-name').textContent`);
  const rowOf = name => `${rows}.find(row => row.querySelector('.activity-task-name').textContent === ${JSON.stringify(name)})`;
  assert.equal(await evaluate(`${rows}[0].querySelector('button[aria-label^="Stop "]').getAttribute('aria-label')`), `Stop ${first}`);
  await evaluate(`${rows}[0].querySelector('button[aria-label^="Stop "]').click()`);
  await waitFor(`${rows}.length === 2 && ${rowOf(first)}?.dataset.state === 'stopped' && Boolean(${rowOf(first)}.closest('.finished-tasks')) && !${rowOf(first)}.querySelector('button') && ${rows}.filter(row => row.dataset.state === 'running' && !row.closest('.finished-tasks')).length === 1`, 'the first task’s stop square stopped it alone, listed under Finished while the other runs', 20_000);
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
  // The activity line no longer carries a stop (76df83c): Stop background work is the Activity panel's.
  await evaluate(`${button('.activity-panel .activity-heading', 'Stop background work')}.click()`);
  const forceStop = button('.activity-panel .panel-note', 'Force stop');
  await waitFor(`document.querySelector('.activity-panel .panel-note')?.textContent.includes('Some tasks did not stop') && Boolean(${forceStop})`, 'a stop the tasks ignored offers Force stop', 20_000);
  await evaluate(`${forceStop}.click()`);
  const confirm = `[...document.querySelectorAll('dialog.modal[open]')].find(item => item.getAttribute('aria-label') === ${JSON.stringify("Close Claude's process?")})`;
  await waitFor(`Boolean(${confirm}) && [...${confirm}.querySelectorAll('button')].some(item => item.textContent === 'Close process')`, 'Force stop asks before closing the process');
  await screenshot('force-stop.png');
  await evaluate(`[...${confirm}.querySelectorAll('button')].find(item => item.textContent === 'Close process').click()`);
  await waitFor(`!document.querySelector('.activity-line') && ${rows}.length === 2 && ${rows}.every(row => row.dataset.state === 'failed' && row.querySelector('.activity-task-meta').textContent.includes('Failed'))`, 'closing the process ended both tasks, which read failed', 20_000);
  await waitFor('!document.querySelector("dialog.modal[open]")', 'the confirmation closed');
  // The process is gone, and its tasks outlive it: the engine answers them from the conversation's stored activity.
  const stored = async () => (await bridge.rawCall('session.activity', { sessionId: await evaluate('window.__joloSmoke.state().sessionId') })).activity;
  const deadline = Date.now() + 15_000;
  let kept = await stored();
  while (!(kept?.state === 'idle' && kept.tasks.length === 2 && kept.tasks.every(task => task.status === 'failed')) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); kept = await stored(); }
  assert.deepEqual([kept?.state, kept?.tasks.map(task => task.status)], ['idle', ['failed', 'failed']], 'the closed process\'s tasks are still listed by the engine');
  // Clear finished deletes them for good: from the panel at once, and from the engine, so the next process does not bring them back.
  await evaluate("document.querySelector('.activity-panel .activity-heading button[aria-label=\"Clear finished\"]').click()");
  await waitFor(`${rows}.length === 0`, 'Clear finished removed the failed tasks from the panel');
  const clearedBy = Date.now() + 10_000;
  while ((await stored())?.tasks.length && Date.now() < clearedBy) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await stored())?.tasks, [], 'Clear finished deleted the tasks in the engine');

  // A workflow is one task: it names the line with its phase and finished agents from Claude's progress report, shows as
  // one card titled with its name, its two agents and its one phase with a square per agent, whose chevron opens a line per
  // agent with its model, and Stop background work ends it.
  await send('workflow demo 60000');
  await waitFor(`/^Workflow demo: Say [0-2]\\/2 · /.test(${line} ?? '') && !${line}.includes(' 0 tokens')`, 'the activity line names the workflow, its phase and its finished agents, and no 0 tokens', 20_000);
  await completed('the turn that started the workflow completed');
  // In the chat, where Claude called the Workflow tool: one compact card with its name, `Workflow`, its agents and elapsed
  // time, and a square per agent; its head opens the Activity panel.
  const chatCards = "[...document.querySelectorAll('.conversation .workflow-call')]";
  const chatCard = name => `${chatCards}.find(item => item.querySelector('.workflow-call-title').textContent === ${JSON.stringify(name)})`;
  const chatWords = name => words(`${chatCard(name)}.querySelector('.workflow-call-meta')`);
  const chatSquares = name => `[...${chatCard(name)}.querySelectorAll('.phase-squares span')].map(item => item.dataset.status)`;
  await waitFor(`${chatCards}.length === 1 && ${chatCard('demo')}?.dataset.state === 'running' && /^Workflow 2 agents \\d\\d:\\d\\d$/.test(${chatWords('demo')}) && ${chatSquares('demo')}.join() === 'running,running'`, 'the chat shows the workflow demo as a card: Workflow 2 agents, its elapsed time, two running squares', 20_000);
  await screenshot('workflow-chat-card.png');
  await hidePanel(evaluate, waitFor);
  await evaluate(`${chatCard('demo')}.querySelector('.workflow-call-head').click()`);
  await waitFor(`document.querySelector('.pane-slot.focused .panel-item-tabs [data-panel-type="activity"]')?.getAttribute('aria-selected') === 'true' && !document.querySelector('.pane-slot.focused .inspector').hidden`, 'the chat card’s head opens the Activity panel');
  await evaluate(painted);
  const card = "document.querySelector('.activity-panel .workflow-card')";
  const metas = `[...${card}.querySelectorAll('.card-meta')]`;
  const phase = `${card}.querySelector('.workflow-phase')`;
  const squares = `[...${phase}.querySelectorAll('.phase-squares span')].map(item => item.dataset.status)`;
  await waitFor(`document.querySelectorAll('.activity-panel .workflow-card').length === 1 && !${card}.closest('.finished-tasks') && ${card}.querySelector('.workflow-title').textContent === 'demo' && ${words(`${metas}[0]`)} === 'Workflow Running'`, 'the Activity panel shows one running workflow card titled demo');
  await waitFor(`${metas}[1]?.firstChild.textContent === '2 agents' && !${card}.textContent.includes(' 0 tokens') && ${card}.querySelectorAll('.workflow-phase').length === 1 && ${words(`${phase}.querySelector('.phase-head')`)} === 'Say 0/2' && ${squares}.join() === 'running,running'`, 'the workflow card shows its two agents, its phase Say 0/2 with two running squares, and no 0 tokens');
  // This turn started a new process, and the tasks Clear finished deleted stayed gone.
  assert.equal(await evaluate(`${rows}.length`), 0, 'the cleared tasks did not come back with the new process');
  // The phase is closed until its chevron is clicked; open, it is a table of its agents: a header row (Agent, Model,
  // Tokens, Time), then a row per agent with its status square, its label and its model, the columns lined up.
  const agentCells = scope => `[...${scope}.querySelectorAll('.phase-agent')].map(row => [...row.querySelectorAll('[role=cell]')].slice(0, 4).map(cell => cell.textContent))`;
  const agentSquares = scope => `[...${scope}.querySelectorAll('.phase-agent .agent-square')].map(square => square.getAttribute('aria-label'))`;
  const aligned = scope => `(() => { const head = [...${scope}.querySelectorAll('.phase-agents-head > *')]; const rows = [...${scope}.querySelectorAll('.phase-agent')]; const edge = (cell, side) => cell.getBoundingClientRect()[side]; return head.map(cell => cell.textContent).join() === 'Agent,Model,Tokens,Time' && rows.length > 0 && rows.every(row => { const cells = row.querySelectorAll('[role=cell]'); return Math.abs(edge(cells[1], 'left') - edge(head[1], 'left')) < 1 && Math.abs(edge(cells[2], 'right') - edge(head[2], 'right')) < 1 && Math.abs(edge(cells[3], 'right') - edge(head[3], 'right')) < 1; }); })()`;
  assert.equal(await evaluate(`${phase}.tagName === 'DETAILS' && !${phase}.open && Boolean(${phase}.querySelector('summary .activity-disclosure'))`), true);
  await evaluate(`${phase}.querySelector('summary').click()`);
  await waitFor(`${phase}.open && ${agentCells(phase)}.length === 2 && ${agentCells(phase)}[0][0] === 'say:1' && ${agentCells(phase)}[0][1] === 'Fable 5.1' && ${agentCells(phase)}[1][0] === 'say:2' && ${agentCells(phase)}[1][1] === 'Fable 5.1'`, 'the Say phase opens to a table with a row per agent, say:1 first, with its model');
  assert.equal(await evaluate(aligned(phase)), true, 'the agent table’s Model, Tokens and Time columns line up under their headers');
  await screenshot('workflow.png');
  await evaluate(`${button('.activity-panel .activity-heading', 'Stop background work')}.click()`);
  await waitFor(`!document.querySelector('.activity-line') && ${card}?.dataset.state === 'stopped' && ${words(`${metas}[0]`)} === 'Workflow Stopped' && !${card}.querySelector('.stop-task') && Boolean(${card}.closest('.finished-tasks'))`, 'Stop background work ended the workflow, listed among the finished', 20_000);
  // Its last report still lists its agents as started: their squares read stopped, as the workflow does, never running
  // (one that finished before the stop reads done).
  const done = Number(await evaluate(`${phase}.querySelector('.phase-head').lastChild.textContent.split('/')[0]`));
  assert.deepEqual(await evaluate(squares), [...Array(done).fill('done'), ...Array(2 - done).fill('stopped')]);
  assert.ok(done < 2, 'the workflow was stopped before both agents were done');
  // The chat card reads the same: Stopped, its squares as the panel's.
  await waitFor(`${chatCard('demo')}?.dataset.state === 'stopped' && /^Workflow 2 agents \\d\\d:\\d\\d Stopped$/.test(${chatWords('demo')})`, 'the chat card of the stopped workflow reads Stopped');
  assert.deepEqual(await evaluate(chatSquares('demo')), [...Array(done).fill('done'), ...Array(2 - done).fill('stopped')]);
  // Its agents' squares read the same, and the phase stayed open through the stop.
  assert.equal(await evaluate(`${phase}.open && ${agentSquares(phase)}.at(-1) === 'Stopped' && !${agentSquares(phase)}.includes('Running') && !${phase}.textContent.includes('Running')`), true);

  // A workflow that completes shows how it ended: Claude's summary, and its output file by name with the path on hover.
  await send('workflow quick 1500');
  await completed('the turn that started the second workflow completed');
  await selectPanel(evaluate, waitFor, 'Activity');
  const quick = "[...document.querySelectorAll('.activity-panel .workflow-card')].find(item => item.querySelector('.workflow-title').textContent === 'quick')";
  await waitFor(`${quick}?.dataset.state === 'completed' && Boolean(${quick}.closest('.finished-tasks')) && ${quick}.querySelector('.activity-summary')?.textContent === 'Dynamic workflow "Workflow quick" completed'`, 'the completed workflow card shows its summary', 20_000);
  assert.deepEqual(await evaluate(`(() => { const output = ${quick}.querySelector('.activity-output'); return [output.textContent, output.title]; })()`), ['Output: quick.output', '/tmp/quick.output']);
  // Its summary and output sit apart below its phases; its phase opens to its two finished agents, each with a preview
  // of its result on one line, which a click on the agent's row shows whole.
  assert.equal(await evaluate(`(() => { const ending = ${quick}.querySelector('.workflow-ending'); const phases = ${quick}.querySelector('.workflow-phases'); return Boolean(ending && ending.contains(${quick}.querySelector('.activity-summary'))) && ending.getBoundingClientRect().top >= phases.getBoundingClientRect().bottom && getComputedStyle(ending).borderTopWidth === '1px'; })()`), true, 'the completed workflow’s summary and output are set apart below its phases');
  const quickPhase = `${quick}.querySelector('.workflow-phase')`;
  await evaluate(`${quickPhase}.querySelector('summary').click()`);
  await waitFor(`${quickPhase}.open && ${agentCells(quickPhase)}.length === 2 && ${agentSquares(quickPhase)}.join() === 'Done,Done' && ${quickPhase}.querySelectorAll('.phase-agent-result').length === 2`, 'the completed workflow’s phase lists its two done agents with their result previews');
  assert.equal(await evaluate(aligned(quickPhase)), true, 'the completed workflow’s agent columns line up under their headers');
  const firstAgent = `${quickPhase}.querySelector('.phase-agent')`;
  await evaluate(`${firstAgent}.querySelector('.phase-agent-result').click()`);
  await waitFor(`${firstAgent}.hasAttribute('data-expanded') && ${firstAgent}.querySelector('.agent-toggle').getAttribute('aria-expanded') === 'true' && getComputedStyle(${firstAgent}.querySelector('.phase-agent-result')).whiteSpace === 'pre-wrap'`, 'a click on an agent’s preview shows its result whole');
  await screenshot('workflow-finished.png');
  await evaluate(`${firstAgent}.querySelector('.agent-toggle').click()`);
  await waitFor(`!${firstAgent}.hasAttribute('data-expanded') && ${firstAgent}.querySelector('.agent-toggle').getAttribute('aria-expanded') === 'false'`, 'its label’s button cuts the preview to one line again');
  await waitFor(`${chatCards}.length === 2 && ${chatCard('quick')}?.dataset.state === 'completed' && /^Workflow 2 agents \\d\\d:\\d\\d Completed$/.test(${chatWords('quick')}) && ${chatSquares('quick')}.join() === 'done,done'`, 'the chat card of the completed workflow reads Completed with two done squares');
  await waitFor("window.__joloSmoke.state().assistantText.includes('Workflow quick done.')", 'Claude reported the completed workflow', 20_000);
  await completed('the report of the completed workflow completed');

  report.checks.push('background work is listed and stopped from the Activity panel, the stopped tasks under Finished 2, which Clear finished hides, the task rows of the sidebar left as they were; AskUserQuestion and ExitPlanMode are answered from dialog cards; tasks that ignore Stop background work are ended by Force stop after the Close process confirmation and read Failed, are still listed once the process is gone, and Clear finished deletes them for good, past the next process; a workflow names the activity line with its phase and finished agents, shows as one card titled with its name, its two agents and its phase Say 0/2 with a square per agent, whose chevron opens a table of its agents (Agent, Model, Tokens, Time, the columns lined up, a status square per row), and Stop background work ends it, its squares reading stopped; a workflow that completes shows Claude\'s summary and its output file set apart below its phases, and an agent\'s preview opens whole from its row');
  report.checks.push('a running task stops alone by the square at the top right of its row, named Stop <its description>, and moves under Finished while the other runs on');
  report.checks.push('a Workflow call shows in the chat as a compact card titled with the workflow\'s name, reading Workflow 2 agents and its elapsed time with a running square per agent, whose head opens the Activity panel; it reads Stopped with its squares as the panel\'s once stopped, and a workflow that completes reads Completed with two done squares');
}
