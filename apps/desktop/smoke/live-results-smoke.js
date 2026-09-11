import { writeFileSync } from 'node:fs';
import path from 'node:path';

// This uses the real mounted renderer and engine in the smoke profile. No board
// navigation or session re-selection is allowed between sending and asserting.
export async function runLiveResultsSmoke({ window, bridge, results, evaluate, waitFor, report }) {
  await evaluate("window.__joloSmoke.newTask()");
  await evaluate("window.__joloSmoke.pickAnswerer('jolo')");
  await waitFor("window.__joloSmoke.state().answerer.startsWith('Jolo')", 'native answerer');
  const run = await evaluate("window.__joloSmoke.send('check final reply without reopening')");
  await waitFor("document.querySelector('.message.assistant')?.textContent.includes('Paragraph 0')", 'live first paragraph');
  await waitFor("window.__joloSmoke.state().runState === 'completed'", 'live completion');
  await waitFor("document.querySelector('.conversation')?.textContent.includes('LIVE_FINAL_REPLY')", 'final reply in mounted chat');
  const position = await evaluate(`(() => {
    const chat = document.querySelector('.conversation');
    const final = [...chat.querySelectorAll('.md p')].find(p => p.textContent.includes('LIVE_FINAL_REPLY'));
    return { gap: chat.scrollHeight - chat.clientHeight - chat.scrollTop, finalTop: final.getBoundingClientRect().top, bottom: chat.getBoundingClientRect().bottom };
  })()`);
  writeFileSync(path.join(results, 'live-results.png'), (await window.webContents.capturePage()).toPNG());
  if (position.gap > 100 || position.finalTop >= position.bottom) throw new Error(`final reply rendered but left offscreen: ${JSON.stringify(position)}`);
  report.checks.push('a long streamed reply appears and stays visible in the mounted chat without reopening');
  if ((await bridge.rawCall('run.snapshot', { runId: run.id })).run.state !== 'completed') throw new Error('run did not finish');

  await evaluate("window.__joloSmoke.newTask()");
  const ack = bridge.relay.ack;
  const heldAcks = [];
  bridge.relay.ack = id => heldAcks.push(id); // a busy renderer has not returned its credits yet
  try {
    const delayed = await evaluate("window.__joloSmoke.send('finish while the renderer is busy')");
    const deadline = Date.now() + 15_000;
    while ((await bridge.rawCall('run.snapshot', { runId: delayed.id })).run.state !== 'completed') {
      if (Date.now() > deadline) throw new Error('delayed run did not complete');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!bridge.relay.stats.queued) throw new Error('fixture did not hold completion events in the relay');
    const before = (await bridge.rawCall('engine.status', {})).engineBootId;
    // Source updates reload the engine as soon as work finishes. Its socket
    // cursor can be ahead of what the renderer has received and acknowledged.
    for (;;) {
      try { await bridge.rawCall('engine.reload', {}); break; }
      catch (error) {
        if (error.code !== 'conflict' || Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    for (;;) {
      const current = await bridge.rawCall('engine.status', {}).catch(() => ({}));
      if (current.engineBootId && current.engineBootId !== before) break;
      if (Date.now() > deadline) throw new Error('engine did not reload');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    bridge.relay.ack = ack;
    for (const id of heldAcks) ack(id);
  }
  await waitFor("document.querySelector('.conversation')?.textContent.includes('LIVE_FINAL_REPLY') && window.__joloSmoke.state().runState === 'completed'", 'final reply after an engine reload, without reopening', 3000);
  report.checks.push('completion buffered for a busy renderer survives engine reload without reopening the chat');

  const current = await evaluate('window.__joloSmoke.state()');
  const { sessions } = await bridge.rawCall('session.list', { projectId: current.projectId, state: 'open' });
  for (let n = sessions.length; n < 6; n++) await bridge.rawCall('session.create', { projectId: current.projectId, workspaceId: current.workspaceId, title: `Tab fixture ${n}` });
  await waitFor("document.querySelector('.sidebar-workspace-toggle')?.title.includes('6 tasks')", 'task count inside workspace row');
  if (await evaluate("Boolean(document.querySelector('#archived-tasks-tab .task-tab-count'))")) throw new Error('open task count appears in Archive');
  writeFileSync(path.join(results, 'task-tabs.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#archived-tasks-tab').click()");
  await waitFor("document.querySelector('#archived-tasks-tab')?.getAttribute('aria-selected') === 'true' && document.querySelector('.task-list')?.textContent.includes('No archived tasks')", 'Archive tab selected');
  await evaluate("document.querySelector('#archived-tasks-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))");
  await waitFor("document.querySelector('#open-tasks-tab')?.getAttribute('aria-selected') === 'true' && document.querySelector('.sidebar-workspace-toggle')?.title.includes('6 tasks')", 'keyboard selects Workspaces with its task count');
  report.checks.push('The folder owns its six-task count; Archive preserves folder grouping, with click and keyboard switching');
  const focusBorders = await evaluate(`(() => {
    const controls = [...document.querySelectorAll('.task-tabs button, .task-tabs select, .new-task, .header-actions button')];
    const borders = [];
    for (const control of controls) {
      control.focus();
      for (const element of [control, control.closest('.task-scope-menu')].filter(Boolean)) {
        const style = getComputedStyle(element);
        if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) borders.push(element.className || element.tagName);
      }
    }
    document.activeElement?.blur();
    return borders;
  })()`);
  if (focusBorders.length) throw new Error(`lingering control focus borders: ${focusBorders.join(', ')}`);
  report.checks.push('focused task tabs, dropdown, new-task and header buttons have no outline borders');
  await evaluate("window.__joloSmoke.newTask()");
  await evaluate("window.__joloSmoke.pickAnswerer('codex')");
  await waitFor("window.__joloSmoke.state().answerer === 'Codex'", 'progress answerer');
  await evaluate("window.__joloSmoke.send('activity-groups')");
  await waitFor("document.querySelectorAll('.activity-group').length === 2 && window.__joloSmoke.state().runState === 'tools'", 'background tools span two activity groups');
  const progress = await evaluate(`(() => {
    const chat = document.querySelector('.conversation');
    return { headers: [...chat.querySelectorAll('.activity-group > summary')].map(el => el.textContent),
      headerSpinners: chat.querySelectorAll('.activity-group > summary .activity-spin').length,
      status: [...chat.querySelectorAll('.run-note')].map(el => el.textContent) };
  })()`);
  if (progress.headerSpinners || progress.headers.some(label => !label.startsWith('Task activity')) || progress.status.length !== 1 || !progress.status[0].startsWith('Using tools · Codex')) throw new Error(`duplicate task progress: ${JSON.stringify(progress)}`);
  await evaluate("document.querySelector('.activity-group').open = true");
  writeFileSync(path.join(results, 'single-task-progress.png'), (await window.webContents.capturePage()).toPNG());
  await waitFor("window.__joloSmoke.state().runState === 'completed' && !document.querySelector('.run-note')", 'progress disappears after task completion');
  if (!(await evaluate("document.querySelector('.activity-group').open && document.querySelectorAll('.activity-group').length === 2 && !document.querySelector('.conversation .activity-spin, .conversation .activity-pulse')"))) throw new Error('completed activity lost expansion or kept animating');
  report.checks.push('background tools spanning commentary retain their activity groups with one live task status; completion removes progress and keeps expansion');
  writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
}
