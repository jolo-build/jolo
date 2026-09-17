import assert from 'node:assert/strict';
import { app, nativeTheme } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_THEMES } from '@jolo/themes';
import { selectPanel } from './panel-controls.js';

export async function runThemesSmoke({ window, evaluate, waitFor, report, results }) {
  const originalMode = nativeTheme.themeSource, originalSize = window.getSize();
  const originalThrottling = window.webContents.getBackgroundThrottling();
  // Keep startup animation frames running when the user switches to another app during the check.
  window.webContents.setBackgroundThrottling(false);
  const messages = [];
  const onConsole = event => { messages.push(event.message); if (messages.length > 20) messages.shift(); };
  window.webContents.on('console-message', onConsole);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const choose = async id => {
    await evaluate(`(() => { const select = document.querySelector('[aria-label="Color theme"]'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await settle();
  };
  const save = async id => {
    await choose(id);
    await evaluate("document.querySelector('.settings-savebar button[type=submit]').click()");
    await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(id)} && localStorage.getItem('jolo.theme') === ${JSON.stringify(id)} && document.querySelector('.settings-savebar button[type=submit]').disabled`, `${id} saved and applied`);
    await settle();
  };
  const openSettings = async () => {
    await evaluate("document.querySelector('.settings-link').click()");
    await waitFor("Boolean(document.querySelector('.settings-page'))", 'settings opened');
    await evaluate("document.querySelector('.settings-nav [data-section=appearance]').click()");
    await settle();
  };
  const reload = async () => {
    await new Promise((resolve, reject) => {
      const loaded = () => { clearTimeout(timer); resolve(null); };
      const timer = setTimeout(() => { window.webContents.removeListener('did-finish-load', loaded); reject(new Error('theme reload timed out')); }, 10000);
      window.webContents.once('did-finish-load', loaded);
      window.webContents.reload();
    });
    // A hidden fresh document may suspend its first animation frames even with
    // background throttling disabled. Show this disposable window for layout QA.
    window.show();
    window.focus();
    app.focus({ steal: true });
    try { await waitFor("Boolean(window.__joloSmoke) && Boolean(document.querySelector('.board')) && document.querySelector('#startup-screen').hidden", 'themed renderer restored'); }
    catch (error) {
      const state = await evaluate("({ url: location.href, ready: document.readyState, visibility: document.visibilityState, theme: document.documentElement.dataset.theme, sheets: [...document.styleSheets].map(sheet => sheet.href), bridge: Boolean(window.jolo), smoke: window.jolo?.smoke, html: document.body.innerHTML.slice(0, 2500) })");
      throw new Error(`${error.message}; page=${JSON.stringify(state)}; console=${JSON.stringify(messages)}`);
    }
  };
  const cssColor = hex => `rgb(${[1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
  try {
    window.setSize(1200, 840);
    await evaluate('window.__joloSmoke.showTask()');
    await waitFor("window.__joloSmoke.state().workspaceId && !window.__joloSmoke.state().standalone", 'folder workspace ready');
    // Resizing closes popovers; let the new task layout settle before opening its menu.
    await settle();
    await selectPanel(evaluate, waitFor, 'Terminal');
    await waitFor('Boolean(window.__joloTerminal?.ready)', 'terminal ready');
    await evaluate("window.__themeTerminal = window.__joloTerminal; window.__themeTerminal.input('export JOLO_THEME_MARKER=retained\\n')");
    await openSettings();
    assert.deepEqual(await evaluate("[...document.querySelector('[aria-label=\"Color theme\"]').options].map(option => option.value)"), ['system', ...BUILTIN_THEMES.slice(1).map(theme => theme.id)]);
    await choose('catppuccin-mocha');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'system', 'draft selection only changes its preview');
    await evaluate("[...document.querySelectorAll('.settings-savebar button')].find(button => button.textContent === 'Discard changes').click()");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Color theme\"]').value"), 'system');
    report.checks.push('Appearance lists all CLI palettes and discards an unsaved theme choice');

    for (const theme of BUILTIN_THEMES.slice(1)) {
      const light = ['white', 'catppuccin-latte', 'github-light'].includes(theme.id);
      nativeTheme.themeSource = light ? 'dark' : 'light';
      await save(theme.id);
      const actual = await evaluate(`(() => {
        const probe = document.createElement('pre'); probe.className = 'md-code';
        probe.innerHTML = '<span class="syntax-token keyword">const</span> <span class="syntax-token string">"hello"</span>';
        document.body.append(probe);
        const colors = { background: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          keyword: getComputedStyle(probe.children[0]).color, string: getComputedStyle(probe.children[1]).color,
          terminal: window.__joloTerminal.theme(), retained: window.__joloTerminal === window.__themeTerminal };
        probe.remove(); return colors;
      })()`);
      assert.equal(actual.background, cssColor(theme.colors.background));
      assert.equal(actual.text, cssColor(theme.colors.text));
      assert.equal(actual.keyword, cssColor(theme.colors.keyword));
      assert.equal(actual.string, cssColor(theme.colors.string));
      assert.equal(actual.scheme, light ? 'light' : 'dark');
      assert.equal(actual.terminal.background, theme.colors.background);
      assert.equal(actual.terminal.red, theme.colors.error);
      assert(actual.retained, 'switching palettes remounted the shell');
      assert(await evaluate(`(() => {
        const cards = document.querySelectorAll('.settings-appearance > .settings-card');
        const select = cards[0].querySelector('.select-field');
        return cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().bottom >= 16
          && getComputedStyle(select).borderTopWidth === '1px'
          && getComputedStyle(select.querySelector('select')).backgroundColor !== getComputedStyle(document.body).backgroundColor;
      })()`), 'theme selector needs a visible boundary and the Fonts card needs spacing');
      writeFileSync(path.join(results, `theme-${theme.id}.png`), (await window.webContents.capturePage()).toPNG());
    }
    report.checks.push(`All ${BUILTIN_THEMES.length - 1} palettes color the interface, syntax, and the existing terminal even with the opposite OS appearance`);
    window.setSize(720, 560);
    await settle();
    assert(await evaluate("[...document.querySelectorAll('.settings-theme-preview, .settings-savebar, [aria-label=\"Color theme\"]')].every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth; })"), 'theme controls overflow a narrow window');
    writeFileSync(path.join(results, 'theme-narrow.png'), (await window.webContents.capturePage()).toPNG());

    await save('system');
    for (const mode of /** @type {const} */ (['light', 'dark'])) {
      nativeTheme.themeSource = mode;
      await waitFor(`getComputedStyle(document.body).backgroundColor === '${mode === 'dark' ? 'rgb(25, 26, 28)' : 'rgb(252, 252, 251)'}' && window.__joloTerminal.theme().background === '${mode === 'dark' ? '#191a1c' : '#fcfcfb'}'`, `system follows ${mode} appearance`);
    }
    assert(await evaluate("!document.documentElement.style.getPropertyValue('--syntax-keyword') && !document.documentElement.style.colorScheme"), 'system default left palette overrides behind');
    await evaluate("document.querySelector('[aria-label=\"Back to workspace\"]').click()");
    await waitFor("!document.querySelector('.settings-page')", 'workspace reopened');
    await evaluate("window.__joloTerminal.input('printf \"theme-%s-ok\\n\" \"$JOLO_THEME_MARKER\"\\n')");
    await waitFor("window.__joloTerminal.text().includes('theme-retained-ok')", 'shell environment retained through theme changes');
    await openSettings();
    await save('white');
    await reload();
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'white');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 255, 255)');
    await evaluate("window.__joloSmoke.showTask()");
    await openSettings();
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Color theme\"]').value"), 'white');
    writeFileSync(path.join(results, 'theme-white-reload.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("localStorage.setItem('jolo.theme', 'obsolete-theme')");
    await reload();
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'system');
    report.checks.push('Themes fit a narrow window, preserve the live shell, survive reload, and fall back safely for an obsolete preference');
    report.checks.push('System default clears named colors and follows OS changes in both the interface and terminal');
    writeFileSync(path.join(results, 'themes-smoke.json'), JSON.stringify(report, null, 2));
  } finally { nativeTheme.themeSource = originalMode; window.setSize(...originalSize); window.webContents.setBackgroundThrottling(originalThrottling); window.webContents.removeListener('console-message', onConsole); }
}
