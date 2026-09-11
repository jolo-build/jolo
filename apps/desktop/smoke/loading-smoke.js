import { nativeTheme } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Hold styles and real startup reads in an isolated profile, so fast machines
// still exercise the first paint, refresh, and failure states deterministically.
export function prepareLoadingSmoke({ window, bridge, root }) {
  const results = process.env.JOLO_SMOKE_RESULTS || path.join(root, 'smoke-results');
  mkdirSync(results, { recursive: true });
  const call = bridge.call.bind(bridge);
  const requests = window.webContents.session.webRequest;
  const pendingStyles = [];
  const pendingFonts = [];
  let holdStyles = true, holdFonts = true;
  requests.onBeforeRequest((details, callback) => {
    if (details.webContentsId === window.webContents.id && details.resourceType === 'stylesheet') {
      if (holdStyles) { pendingStyles.push(callback); return; }
    }
    if (details.webContentsId === window.webContents.id && details.resourceType === 'font' && holdFonts) {
      pendingFonts.push(callback); return;
    }
    callback({});
  });
  const releaseStyles = (cancel = false) => {
    holdStyles = false;
    for (const callback of pendingStyles.splice(0)) callback({ cancel });
  };
  const releaseFonts = () => {
    holdFonts = false;
    for (const callback of pendingFonts.splice(0)) callback({});
  };
  let release, held = new Promise(resolve => { release = resolve; }), failConnection = false;
  bridge.call = async (method, params) => {
    if (failConnection && method === 'engine.status') return { ok: false, error: { code: 'unavailable', message: 'Startup connection fixture unavailable' } };
    if (['settings.get', 'board.list', 'board.tasks', 'agent.catalog'].includes(method)) await held;
    return call(method, params);
  };
  const evaluate = code => window.webContents.executeJavaScript(code);
  const waitFor = async (code, label) => {
    const until = Date.now() + 15_000;
    while (!(await evaluate(code))) {
      if (Date.now() > until) {
        const state = await evaluate(`({ readyState: document.readyState, splash: document.getElementById('startup-screen')?.outerHTML, mounted: !!document.querySelector('.app'), styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => ({ href: link.href, loaded: !!link.sheet })) })`);
        throw new Error(`loading smoke timeout: ${label}: ${JSON.stringify(state)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const settle = () => evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
  const reload = () => new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
  return async () => {
    const checks = [];
    const originalTheme = nativeTheme.themeSource;
    try {
      await waitFor("document.querySelector('link[href=\"styles.css\"]') && !document.querySelector('.app') && !document.getElementById('startup-screen').hidden", 'loading paints before application styles and React');
      for (const theme of /** @type {const} */ (['light', 'dark'])) {
        nativeTheme.themeSource = theme;
        await settle();
        const measured = await evaluate(`(() => {
          const logo = document.querySelector('.startup-logo');
          const rect = logo.getBoundingClientRect();
          const root = document.getElementById('root');
          return { loaded: logo.complete && logo.naturalWidth > 0, dx: Math.abs(rect.x + rect.width / 2 - innerWidth / 2), dy: Math.abs(rect.y + rect.height / 2 - innerHeight / 2), blocked: root.inert && root.getAttribute('aria-busy') === 'true', background: getComputedStyle(document.getElementById('startup-screen')).backgroundColor, filter: getComputedStyle(logo).filter, status: document.querySelector('.startup-status').textContent, unstyled: !document.querySelector('link[href="styles.css"]').sheet };
        })()`);
        if (!measured.loaded || !measured.blocked || measured.dx > 1 || measured.dy > 1 || measured.background !== (theme === 'dark' ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)') || (theme === 'dark' && measured.filter !== 'invert(1)')) throw new Error(`${theme} splash layout: ${JSON.stringify(measured)}`);
        if (!measured.unstyled || measured.status !== 'Loading Jolo…') throw new Error(`splash must work before application styles: ${JSON.stringify(measured)}`);
        writeFileSync(path.join(results, `loading-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
      checks.push('the centered Jolo logo and loading label paint before application styles and React, in light and dark mode');
      if (pendingStyles.length !== 2) throw new Error(`expected two held stylesheet requests, got ${pendingStyles.length}`);
      releaseStyles(true);
      await waitFor("document.getElementById('startup-screen').hasAttribute('data-failed') && document.getElementById('root').inert && document.querySelector('.startup-status').hidden && !document.querySelector('.startup-detail:not(.startup-status)').hidden", 'failed styles show a usable retry screen');
      const retried = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('loading smoke timeout: retry did not reload the page')), 15_000);
        window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      });
      // Return the evaluation result before the click destroys its JS context.
      await evaluate("setTimeout(() => document.querySelector('#startup-screen button').click(), 50); true");
      await retried;
      await waitFor("document.querySelector('.app') && !document.getElementById('startup-screen').hidden", 'mounted interface stays covered while data loads');
      release();
      await waitFor("document.querySelector('header') && document.querySelector('.sidebar') && document.querySelector('.board .empty-state') && document.querySelector('footer')?.textContent.includes('Local engine') && document.fonts.status === 'loading'", 'all components and initial data are mounted while fonts are still loading');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
      if (!pendingFonts.length || !(await evaluate("!document.getElementById('startup-screen').hidden && document.getElementById('root').inert"))) throw new Error('startup revealed the interface before its fonts finished loading');
      releaseFonts();
      await waitFor("document.getElementById('startup-screen').hidden && !document.getElementById('root').inert && document.querySelector('.board .empty-state')", 'initial data is ready and the board is usable');
      if (!(await evaluate("document.fonts.status === 'loaded' && document.fonts.check('13px Inter') && document.querySelector('header').getBoundingClientRect().height > 0 && document.querySelector('.sidebar').getBoundingClientRect().width > 0 && document.querySelector('footer').getBoundingClientRect().height > 0"))) throw new Error('startup ended before the interface finished laying out');
      checks.push('the logo remains over all mounted components until initial data, fonts, and layout are ready, then reveals the interface together');
      checks.push('a failed application stylesheet shows a retry button that reloads successfully');

      held = new Promise(resolve => { release = resolve; });
      await reload();
      await waitFor("document.querySelector('.app') && !document.getElementById('startup-screen').hidden && document.getElementById('root').inert", 'refresh shows loading again');
      release();
      await waitFor("document.getElementById('startup-screen').hidden && !document.getElementById('root').inert", 'refresh finishes loading');
      checks.push('refresh shows the same loading screen and restores interaction afterward');

      const appUrl = window.webContents.getURL();
      const blockedNavigation = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('loading smoke timeout: navigation guard')), 15_000);
        window.webContents.once('will-navigate', event => { clearTimeout(timer); resolve(event.defaultPrevented); });
      });
      await evaluate("setTimeout(() => { location.href = 'blocked-startup-navigation.html'; }, 50); true");
      if (!(await blockedNavigation) || window.webContents.getURL() !== appUrl) throw new Error('startup retry must not permit navigating to another document');
      checks.push('the application can reload itself while navigation to other documents remains blocked');

      failConnection = true;
      await reload();
      await waitFor("document.getElementById('startup-screen').hidden && !document.getElementById('root').inert && document.querySelector('footer')?.textContent.includes('Startup connection fixture unavailable')", 'startup error is visible instead of an endless splash');
      checks.push('a connection failure reveals the interface and its error');
      const report = { measuredAt: new Date().toISOString(), electron: process.versions.electron, checks };
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally {
      release();
      releaseStyles();
      releaseFonts();
      requests.onBeforeRequest(null);
      bridge.call = call;
      nativeTheme.themeSource = originalTheme;
    }
  };
}
