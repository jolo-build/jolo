import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runTaskDragSmoke({ window, evaluate, waitFor, report, results, first, second, third }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const focus = async id => {
    await evaluate(`window.__joloSmoke.focusPane(${JSON.stringify(id)})`);
    await waitFor(`window.__joloSmoke.layout().active === ${JSON.stringify(id)}`, 'drag source focused');
  };
  await focus(third);
  const source = await evaluate('window.__joloSmoke.state()');
  const sourceSelector = `.sidebar .task[data-session-id="${source.sessionId}"]`;
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(sourceSelector)}))`, 'drag source task loaded');
  await evaluate(`window.__dragOriginals = [...document.querySelectorAll('.pane-slot textarea')]; document.querySelector(${JSON.stringify(sourceSelector)}).scrollIntoView({block:'nearest'})`);
  const positions = await evaluate(`(() => {
    const source = document.querySelector(${JSON.stringify(sourceSelector)}).getBoundingClientRect();
    const target = document.querySelector('[data-pane-id="${first}"]').getBoundingClientRect();
    return { source: {x: source.left + source.width/2, y: source.top + source.height/2}, target: {x: target.left + 20, y: target.top + target.height/2} };
  })()`);
  const debug = window.webContents.debugger;
  debug.attach('1.3');
  let dragData;
  const intercepted = (_event, method, params) => { if (method === 'Input.dragIntercepted') dragData = params.data; };
  debug.on('message', intercepted);
  try {
    await debug.sendCommand('Input.setInterceptDrags', { enabled: true });
    window.focus();
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...positions.source });
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...positions.source, button: 'left', buttons: 1, clickCount: 1 });
    for (const fraction of [.1, .3, .6, 1]) {
      await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1,
        x: positions.source.x + (positions.target.x - positions.source.x) * fraction,
        y: positions.source.y + (positions.target.y - positions.source.y) * fraction });
    }
    const deadline = Date.now() + 4000;
    while (!dragData && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert(dragData, 'Dragging the sidebar task did not start a native Chromium drag');
    for (const type of ['dragEnter', 'dragOver']) await debug.sendCommand('Input.dispatchDragEvent', { type, ...positions.target, data: dragData });
    await waitFor(`Boolean(document.querySelector('[data-pane-id="${first}"] .task-split-preview.left'))`, 'left split preview');
    writeFileSync(path.join(results, 'task-drag-preview.png'), (await window.webContents.capturePage()).toPNG());
    await debug.sendCommand('Input.dispatchDragEvent', { type: 'drop', ...positions.target, data: dragData });
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...positions.target, button: 'left', clickCount: 1 });
  } finally {
    await debug.sendCommand('Input.setInterceptDrags', { enabled: false });
    debug.off('message', intercepted);
    debug.detach();
  }
  await waitFor(`window.__joloSmoke.panes().length === 4 && window.__joloSmoke.state().sessionId === ${JSON.stringify(source.sessionId)} && window.__joloSmoke.state().messageCount > 0`, 'dropped task transcript loaded');
  assert(await evaluate(`window.__joloSmoke.state().projectId === ${JSON.stringify(source.projectId)}`), 'Cross-project drop opened the wrong workspace');
  assert(await evaluate(`(() => { const pane = document.querySelector('[data-pane-id="'+window.__joloSmoke.layout().active+'"]'); const target = document.querySelector('[data-pane-id="${first}"]'); return pane.getBoundingClientRect().right <= target.getBoundingClientRect().left + 1; })()`), 'Task was not placed to the left of its target');
  assert(await evaluate('window.__dragOriginals.every(node => node.isConnected)'), 'Dropping remounted an existing composer');
  assert(await evaluate(`document.querySelector('[data-pane-id="${first}"] textarea').value === 'keep this original draft'`), 'Dropping lost the current chat draft');
  await evaluate('window.__joloSmoke.closePane(window.__joloSmoke.layout().active)');
  await waitFor('window.__joloSmoke.panes().length === 3', 'drag split closed');

  // Cancel and unrelated payloads must leave the original layout alone.
  await focus(second);
  const selected = await evaluate('window.__joloSmoke.state().sessionId');
  await waitFor(`Boolean(document.querySelector('.sidebar .task[data-session-id="${selected}"]'))`, 'same-project task in sidebar');
  await evaluate(`(() => {const source=document.querySelector('.sidebar .task[data-session-id="${selected}"]');window.__taskTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__taskTransfer}));})()`);
  await waitFor('Boolean(document.querySelector(".task-split-target"))', 'drag overlay');
  await evaluate(`window.dispatchEvent(new DragEvent('dragend'))`);
  await waitFor('!document.querySelector(".task-split-target")', 'cancelled drag clears overlay');
  await evaluate(`document.querySelector('[data-pane-id="${first}"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}))`);
  assert(await evaluate('window.__joloSmoke.panes().length === 3'), 'Cancelled or unrelated drag created a pane');
  report.checks.push('Native task dragging previews and opens an existing cross-project chat on the left, preserves mounted drafts, and cleans up cancelled drags');
}
