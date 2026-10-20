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
    await selectPanel(evaluate, waitFor, 'Files');
    await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(fixtureUrl)})`);
    await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'browser loaded');
    const guest = [...browserHost.guests.values()][0]?.guest;
    assert(guest, 'native browser guest exists');
    pressClose(guest);
    await waitFor("document.querySelectorAll('.panel-item-tabs [role=tab]').length === 1 && document.querySelector('.panel-item-tabs [role=tab][aria-selected=true]')?.dataset.panelType === 'files'", 'browser shortcut closes only browser tab');
    assert(quits === 0 && !window.isDestroyed(), 'browser shortcut did not close the app');
    report.checks.push('Cmd/Ctrl+W from a focused native browser closes its tab and preserves the neighboring file tab');

    // Cmd/Ctrl+F opens find on the page; the window's own matching reports a count, and Esc closes it.
    const press = (keyCode, modifiers = []) => { window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
    await evaluate("document.querySelector('.composer textarea')?.focus()");
    press('F', [process.platform === 'darwin' ? 'meta' : 'control']);
    await waitFor("document.activeElement === document.querySelector('.find-bar input')", 'find bar opens focused');
    await evaluate("(() => { const input = document.querySelector('.find-bar input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'New chat'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor("/^1\\/\\d+$/.test(document.querySelector('.find-count')?.textContent ?? '') && CSS.highlights.get('jolo-find')?.size > 0", 'find counts and marks its matches');
    await evaluate("document.querySelector('.find-bar [aria-label=\"Next match\"]').click()");
    await waitFor("/^2\\/\\d+$|^1\\/1$/.test(document.querySelector('.find-count')?.textContent ?? '')", 'next steps to the following match');
    press('Escape');
    await waitFor("!document.querySelector('.find-bar') && !CSS.highlights.get('jolo-find')", 'Esc closes find and clears the marks');
    report.checks.push('Cmd/Ctrl+F opens find in page with highlighted matches and a count, Enter steps, and Esc closes it');

    await selectPanel(evaluate, waitFor, 'Terminal');
    await waitFor("Boolean(document.querySelector('.xterm-helper-textarea'))", 'terminal mounted');
    await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    pressClose();
    await waitFor("document.querySelectorAll('.panel-item-tabs [role=tab]').length === 1 && !document.querySelector('.xterm-helper-textarea')", 'terminal tab closed');
    assert(quits === 0, 'terminal shortcut did not quit');
    pressClose();
    await waitFor("document.querySelectorAll('.panel-item-tabs [role=tab]').length === 0 && document.querySelector('.inspector').hidden && !document.querySelector('.context-divider')", 'last tab closes the panel and releases its space');
    assert(quits === 0, 'last tab did not quit');
    await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(fixtureUrl)})`);
    await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'sole browser loaded');
    pressClose([...browserHost.guests.values()][0].guest);
    await waitFor("document.querySelector('.inspector').hidden && !document.querySelector('webview')", 'sole native browser closes the panel');
    assert(quits === 0, 'sole browser shortcut did not quit');
    await selectPanel(evaluate, waitFor, 'Files');
    await evaluate("document.querySelector('.panel-item-close').click()");
    await waitFor("document.querySelector('.inspector').hidden && !document.querySelector('.context-divider')", 'last tab close button also closes panel');
    await selectPanel(evaluate, waitFor, 'Files');
    const first = await evaluate('window.__joloSmoke.layout().active');
    await evaluate("window.__joloSmoke.split('x')");
    await waitFor('window.__joloSmoke.panes().length === 2 && window.__joloSmoke.panes().every(pane => pane.projectId)', 'second workspace ready');
    assert(await evaluate(`window.__joloSmoke.layout().active !== ${JSON.stringify(first)}`), 'new pane is active');
    pressClose();
    await waitFor(`window.__joloSmoke.layout().active === ${JSON.stringify(first)} && document.querySelectorAll('.panel-item-tabs [role=tab]').length === 0 && document.querySelector('.pane-slot.focused .inspector').hidden`, 'last tab in the other split closes its panel before quit');
    assert(quits === 0, 'another open panel prevents quitting');
    await waitFor("[...document.querySelectorAll('.inspector')].every(panel => panel.hidden)", 'all panels closed');
    pressClose();
    const deadline = Date.now() + 3000;
    while (!quits && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert(quits === 1, 'no panel routes exactly one app quit');
    report.checks.push('Closing the last tab by shortcut or close button collapses the panel immediately; the next close quits the desktop exactly once');
    report.checks.push('An open panel in another split is handled before the app can quit');
  } finally { app.quit = quit; }
}
