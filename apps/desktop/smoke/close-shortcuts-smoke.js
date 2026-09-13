import { app } from 'electron';
import { selectPanel } from './panel-controls.js';

export async function runCloseShortcutsSmoke({ window, browserHost, fixtureUrl, evaluate, waitFor, report }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pressClose = (contents = window.webContents) => {
    contents.focus();
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers });
  };
  let quits = 0;
  const quit = app.quit;
  app.quit = () => { quits++; };
  try {
    await evaluate('window.__joloSmoke.showTask()');
    await selectPanel(evaluate, waitFor, 'Files');
    await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(fixtureUrl)})`);
    await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'browser loaded');
    const guest = [...browserHost.guests.values()][0]?.guest;
    assert(guest, 'native browser guest exists');
    pressClose(guest);
    await waitFor("document.querySelectorAll('.panel-item-tabs [role=tab]').length === 1 && document.querySelector('.panel-item-tabs [role=tab][aria-selected=true]')?.dataset.panelType === 'files'", 'browser shortcut closes only browser tab');
    assert(quits === 0 && !window.isDestroyed(), 'browser shortcut did not close the app');
    report.checks.push('Cmd/Ctrl+W from a focused native browser closes its tab and preserves the neighboring file tab');

    await selectPanel(evaluate, waitFor, 'Terminal');
    await waitFor("Boolean(document.querySelector('.xterm-helper-textarea'))", 'terminal mounted');
    await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    pressClose();
    await waitFor("document.querySelectorAll('.panel-item-tabs [role=tab]').length === 1 && !document.querySelector('.xterm-helper-textarea')", 'terminal tab closed');
    assert(quits === 0, 'terminal shortcut did not quit');
    pressClose();
    await waitFor("document.querySelectorAll('.panel-item-tabs [role=tab]').length === 0 && !document.querySelector('.inspector').hidden && document.querySelector('.panel-empty')?.textContent.includes('No open tabs')", 'last tab leaves the empty panel open');
    assert(quits === 0, 'last tab did not quit');
    pressClose();
    await waitFor("document.querySelector('.inspector').hidden", 'empty panel closed');
    assert(quits === 0, 'closing the panel did not quit');
    await selectPanel(evaluate, waitFor, 'Files');
    const first = await evaluate('window.__joloSmoke.layout().active');
    await evaluate("window.__joloSmoke.split('x')");
    await waitFor('window.__joloSmoke.panes().length === 2 && window.__joloSmoke.panes().every(pane => pane.projectId)', 'second workspace ready');
    assert(await evaluate(`window.__joloSmoke.layout().active !== ${JSON.stringify(first)}`), 'new pane is active');
    pressClose();
    await waitFor(`window.__joloSmoke.layout().active === ${JSON.stringify(first)} && document.querySelectorAll('.panel-item-tabs [role=tab]').length === 0 && !document.querySelector('.pane-slot.focused .inspector').hidden`, 'open panel in the other split handled before quit');
    assert(quits === 0, 'another open panel prevents quitting');
    pressClose();
    await waitFor("[...document.querySelectorAll('.inspector')].every(panel => panel.hidden)", 'all panels closed');
    pressClose();
    const deadline = Date.now() + 3000;
    while (!quits && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert(quits === 1, 'no panel routes exactly one app quit');
    report.checks.push('Cmd/Ctrl+W closes terminal and file tabs, then the empty panel, then quits the desktop exactly once');
    report.checks.push('An open panel in another split is handled before the app can quit');
  } finally { app.quit = quit; }
}
