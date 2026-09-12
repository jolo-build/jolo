import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { selectPanel, hidePanel } from './panel-controls.js';

export async function runContextPanelsSmoke({ window, bridge, fixtureUrl, evaluate, waitFor, report, results }) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const select = label => selectPanel(evaluate, waitFor, label);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async selector => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await frame();
  };
  const toggleMenu = async () => {
    // A DOM .click() omits native pointer light-dismiss and missed the reopen race.
    for (let i = 0; i < 2; i++) {
      await click('.header [aria-label="Panels"]');
      await waitFor("Boolean(document.querySelector('.panel-menu:popover-open')) && document.querySelector('.header [aria-label=Panels]').getAttribute('aria-expanded') === 'true'", 'mouse click opens the panel list');
      await click('.header [aria-label="Panels"]');
      await waitFor("!document.querySelector('.panel-menu:popover-open') && document.querySelector('.header [aria-label=Panels]').getAttribute('aria-expanded') === 'false'", 'second mouse click closes the panel list');
    }
  };
  const fits = () => evaluate(`(() => {
    const main = document.querySelector('.pane-body > .main').getBoundingClientRect();
    const panel = document.querySelector('.inspector').getBoundingClientRect();
    const body = document.querySelector('.pane-body').getBoundingClientRect();
    const bar = document.querySelector('.context-bar').getBoundingClientRect();
    const content = document.querySelector('.context-content').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('.context-tabs [role=tab]')];
    return main.width > 300 && panel.left >= main.right - 1 && Math.abs(panel.top - main.top) < 1
      && Math.abs(panel.bottom - body.bottom) < 1 && content.top >= bar.bottom - 1
      && Math.abs(content.bottom - panel.bottom) < 1
      && tabs.every(tab => { const r = tab.getBoundingClientRect(); return r.left >= panel.left && r.right <= panel.right; })
      && !document.querySelector('.task-tools');
  })()`);
  const originalSize = window.getSize(), originalTheme = nativeTheme.themeSource;
  await evaluate('window.__joloSmoke.showTask()');
  window.setSize(1280, 860);
  try {
    await frame();
    await toggleMenu();
    await select('Terminal');
    await waitFor('Boolean(window.__joloTerminal?.ready)', 'terminal shell ready');
    await evaluate("window.__panelTerminal = window.__joloTerminal; window.__panelTerminal.input('export JOLO_PANEL_MARKER=retained; echo right-panel-ready\\n')");
    await waitFor("window.__panelTerminal.text().includes('right-panel-ready')", 'terminal output rendered');
    await select('Checks');
    assert(await fits(), 'Checks do not fit beside the conversation');
    await select('Plans');
    await evaluate("document.querySelector('.plan-pane-head button').click()");
    await waitFor("Boolean(document.querySelector('.plan-new input'))", 'plan form opened');
    await evaluate(`(() => {
      const input = document.querySelector('.plan-new input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Keep this plan draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await select('Terminal');
    assert(await evaluate('window.__joloTerminal === window.__panelTerminal'), 'tab switching replaced the shell');
    await hidePanel(evaluate, waitFor);
    await waitFor("document.querySelector('.inspector').hidden", 'terminal panel hides from its toolbar button');
    await select('Terminal');
    await evaluate("window.__panelTerminal.input('echo $JOLO_PANEL_MARKER\\n')");
    await waitFor("window.__panelTerminal.text().split('\\n').some(line => line.trim() === 'retained')", 'shell state survives hiding and switching tabs');

    // Closing a different panel must not destroy a retained browser page.
    await evaluate(`window.__joloSmoke.openBrowser(${JSON.stringify(fixtureUrl)})`);
    await waitFor("window.__joloSmoke.state().browserTitle === 'Jolo smoke page'", 'browser fixture loaded');
    await evaluate("window.__panelBrowser = document.querySelector('.browser webview'); window.__panelBrowser.executeJavaScript('window.retainedPanelPage = 42')");
    await select('Checks');
    await evaluate("document.querySelector('.context-close').click()");
    await select('Browser');
    assert(await evaluate("document.querySelector('.browser webview') === window.__panelBrowser && window.__panelBrowser.executeJavaScript('window.retainedPanelPage === 42')"), 'closing Checks discarded the browser page');
    // Test the bundled font: fallback fonts hid the slash substitution in earlier input checks.
    await evaluate("document.fonts.load('11px \"JetBrains Mono\"'); document.querySelector('.browser-bar input').focus(); document.querySelector('.browser-bar input').select()");
    window.webContents.focus();
    for (const keyCode of 'https://d') { window.webContents.sendInputEvent({ type: 'char', keyCode }); await frame(); }
    assert(await evaluate(`(() => {
      const input = document.querySelector('.browser-bar input'), style = getComputedStyle(input);
      return input.value === 'https://d' && style.fontVariantLigatures === 'none' && style.fontFeatureSettings.includes('"calt" 0') && style.fontFeatureSettings.includes('"liga" 0');
    })()`), 'address font substitutes the first slash after typing the hostname');
    writeFileSync(path.join(results, 'browser-address-literal.png'), (await window.webContents.capturePage()).toPNG());
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await frame();
    const chatWidth = () => evaluate("document.querySelector('.pane-body > .main').getBoundingClientRect().width");
    const initialChatWidth = await chatWidth();
    const dragPanel = async delta => {
      const point = await evaluate("(() => { const r = document.querySelector('.context-divider').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 80) }; })()");
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      await waitFor("Boolean(document.querySelector('.context-resizing'))", 'panel resize captures the mouse');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + delta, y: point.y });
      await frame();
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + delta, y: point.y, button: 'left', clickCount: 1 });
      await waitFor("!document.querySelector('.context-resizing')", 'panel resize releases the mouse');
      await frame();
    };
    await dragPanel(-80);
    assert(await chatWidth() < initialChatWidth - 60, 'dragging left did not widen the browser');
    await dragPanel(160);
    assert(await chatWidth() > initialChatWidth + 60, 'dragging over the browser lost the resize pointer');
    assert(await evaluate("document.querySelector('.browser webview') === window.__panelBrowser && window.__panelBrowser.executeJavaScript('window.retainedPanelPage === 42')"), 'resizing reloaded the browser');
    await evaluate("document.querySelector('.context-divider').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await frame();
    assert(Math.abs(await chatWidth() - initialChatWidth) < 2, 'double-click did not reset panel width');
    await select('Plans');
    assert(await evaluate("document.querySelector('.plan-new input').value === 'Keep this plan draft'"), 'switching tabs discarded the plan draft');
    await evaluate("document.querySelector('.plan-new [type=button]').click()");
    const { projectId } = await evaluate('window.__joloSmoke.state()');
    await bridge.rawCall('plan.create', { projectId, goal: 'Prepare the workspace update', tasks: [
      { title: 'Review the sidebar', brief: 'Check task progress and model details.' },
      { title: 'Verify the browser panel', brief: 'Keep pages alive while switching tabs.' },
    ] });
    await waitFor("document.querySelectorAll('.plan-task').length === 2", 'plan tasks render in the right panel');
    for (const color of /** @type {const} */ (['light', 'dark'])) {
      nativeTheme.themeSource = color;
      for (const label of ['Terminal', 'Checks', 'Plans']) {
        await select(label);
        await frame();
        assert(await fits(), `${label} geometry is incorrect in ${color} mode`);
        assert(await evaluate("(() => { const panel = document.querySelector('.context-content'); return panel.scrollWidth <= panel.clientWidth; })()"), `${label} overflows horizontally`);
        writeFileSync(path.join(results, `context-${label.toLowerCase()}-${color}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await evaluate("document.querySelector('.header [aria-label=\"Panels\"]').click()");
      await waitFor("Boolean(document.querySelector('.panel-menu:popover-open'))", 'panel menu visible');
      assert(await evaluate("document.querySelectorAll('.panel-menu [role=menuitemradio]').length === 6 && document.querySelector('.panel-menu [aria-checked=true]').getAttribute('aria-label') === 'Plans'"), 'panel menu entries or selected marker are incorrect');
      await frame();
      writeFileSync(path.join(results, `panel-menu-${color}.png`), (await window.webContents.capturePage()).toPNG());
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true, cancelable:true}))");
      assert(await evaluate("document.activeElement.getAttribute('aria-label') === 'Changes'"), 'menu keyboard navigation did not focus the first panel');
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))");
      await waitFor("!document.querySelector('.panel-menu:popover-open') && document.activeElement.getAttribute('aria-label') === 'Panels'", 'Escape closes the menu and restores focus');
      await toggleMenu();
      assert(await evaluate("document.querySelector('.context-tabs [aria-label=Plans]').getAttribute('aria-selected') === 'true' && !document.querySelector('.inspector').hidden"), 'closing the menu changed the selected panel');
      await click('.header [aria-label="Panels"]');
      await waitFor("Boolean(document.querySelector('.panel-menu:popover-open'))", 'menu reopens for outside dismissal');
      await click('.plan-pane-head');
      await waitFor("!document.querySelector('.panel-menu:popover-open')", 'click outside closes the menu');
    }
    // Tab keys select the same panel as toolbar buttons, including compact icon tabs.
    await evaluate("document.querySelector('.context-tabs [aria-selected=true]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true, cancelable:true}))");
    await waitFor("document.querySelector('.context-tabs [aria-label=Checks]').getAttribute('aria-selected') === 'true'", 'keyboard tab navigation');
    window.setSize(760, 680);
    await frame();
    assert(await evaluate("(() => { const main = document.querySelector('.pane-body > .main').getBoundingClientRect(); const panel = document.querySelector('.inspector').getBoundingClientRect(); return main.width === 0 && panel.width > 300 && panel.bottom <= innerHeight; })()"), 'compact panel does not fit its pane');
    await evaluate("document.querySelector('.context-close').click()");
    await waitFor("document.querySelector('.pane-body > .main').getBoundingClientRect().width > 300", 'closing compact context restores the chat');
    await select('Terminal');
    await evaluate("document.querySelector('.terminal [aria-label=\"Close terminal\"]').click()");
    await waitFor('!window.__joloTerminal && document.querySelector(".inspector").hidden', 'explicit terminal close releases its shell');
    report.checks.push('one Panels menu lists all six panels; repeated native mouse clicks open and close it without hiding the selected panel, and outside clicks, keyboard navigation and Escape work');
    report.checks.push('Terminal, Checks and Plans open on the right and fit light, dark and compact layouts; the bottom tools bar is gone');
    report.checks.push('tab switching and hiding preserve shell state, browser pages and plan drafts; explicit terminal close releases its shell');
    report.checks.push('keyboard tab navigation works and closing a compact panel restores the conversation');
  } finally { window.setSize(...originalSize); nativeTheme.themeSource = originalTheme; }
}
