import { selectPanel } from './panel-controls.js';

// Use native clicks and keyboard input: DOM .click() does not transfer guest focus.
export async function runZoomSmoke({ window, browserHost, fixtureUrl, evaluate, waitFor, report }) {
  const host = window.webContents;
  const originalZoom = host.getZoomFactor();
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async selector => {
    const point = await evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:r.x+r.width/2, y:r.y+Math.min(r.height/2, 60)};
    })()`);
    const position = {x:Math.round(point.x*host.getZoomFactor()), y:Math.round(point.y*host.getZoomFactor())};
    host.sendInputEvent({type:'mouseDown', ...position, button:'left', clickCount:1});
    host.sendInputEvent({type:'mouseUp', ...position, button:'left', clickCount:1});
    await frame();
  };
  const press = async keyCode => {
    const focused = await evaluate("document.activeElement.tagName === 'WEBVIEW'") ? guest : host;
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    focused.sendInputEvent({type:'keyDown', keyCode, modifiers});
    focused.sendInputEvent({type:'keyUp', keyCode, modifiers});
    await frame();
  };
  await evaluate('window.__joloSmoke.showTask()');
  await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(fixtureUrl)})`);
  await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'zoom browser fixture loaded');
  const guest = [...browserHost.guests.values()][0]?.guest;
  if (!guest) throw new Error('zoom browser did not attach');
  const check = (application, page, label) => {
    const actual = {application:host.getZoomFactor(), page:guest.getZoomFactor()};
    if (Math.abs(actual.application-application)>.001 || Math.abs(actual.page-page)>.001) {
      throw new Error(`${label}: expected app=${application}, page=${page}; got ${JSON.stringify(actual)}`);
    }
  };
  try {
    host.setZoomFactor(1); guest.setZoomFactor(1);
    window.focus();
    await click('.browser webview');
    await press('=');
    check(1, 1.2, 'browser click zooms only the page');
    await press('=');
    check(1, 1.44, 'browser repeated zoom');
    await click('.conversation');
    await press('=');
    check(1.2, 1.44, 'chat click zooms the interface and preserves page zoom');
    await click('.browser webview');
    await press('=');
    check(1.2, 1.728, 'browser zoom preserves an enlarged interface');
    await press('-');
    check(1.2, 1.44, 'browser zoom out preserves an enlarged interface');
    await click('.conversation');
    await press('-');
    check(1, 1.44, 'chat zoom out preserves page zoom');
    await click('.browser webview');
    await press('0');
    check(1, 1, 'browser reset');
    report.checks.push('Native clicks between browser and chat route zoom in, out, and reset to the selected document with independent zoom levels');
    await press('=');
    for (const selector of ['.browser-bar input', '.composer textarea']) {
      await click(selector);
      await press('=');
      check(1.2, 1.2, `${selector} zooms the interface`);
      await press('0');
      check(1, 1.2, `${selector} resets only the interface`);
    }

    for (const [panel, selector] of [['Files', '.context-content'], ['Terminal', '.xterm-host'], ['Plans', '.context-content'], ['Checks', '.context-content']]) {
      await selectPanel(evaluate, waitFor, panel);
      if (panel === 'Terminal') await waitFor('Boolean(window.__joloTerminal?.ready)', 'zoom terminal ready');
      await click(selector);
      await press('=');
      check(1.2, 1.2, `${panel} zooms with the interface`);
      await press('0');
      check(1, 1.2, `${panel} reset preserves the retained browser zoom`);
    }
    report.checks.push('Files, Terminal, Plans, and Checks share the chat/interface zoom while a retained browser keeps its own zoom');
  } finally { host.setZoomFactor(originalZoom); if (!guest.isDestroyed()) guest.setZoomFactor(1); }
}
