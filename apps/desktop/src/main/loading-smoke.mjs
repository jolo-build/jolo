import { nativeTheme } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Hold real startup reads in an isolated profile, so fast machines still exercise
// the first paint, refresh, and connection-failure states deterministically.
export function prepareLoadingSmoke({ window, bridge, root }) {
  const results = process.env.JOLO_SMOKE_RESULTS || path.join(root, 'smoke-results');
  mkdirSync(results, { recursive: true });
  const call = bridge.call.bind(bridge);
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
      if (Date.now() > until) throw new Error(`loading smoke timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const settle = () => evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
  const reload = () => new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
  return async () => {
    const checks = [];
    const originalTheme = nativeTheme.themeSource;
    try {
      await waitFor("document.querySelector('.app') && !document.getElementById('startup-screen').hidden", 'mounted interface stays covered while data loads');
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme;
        await settle();
        const measured = await evaluate(`(() => {
          const logo = document.querySelector('.startup-logo');
          const rect = logo.getBoundingClientRect();
          const root = document.getElementById('root');
          return { loaded: logo.complete && logo.naturalWidth > 0, dx: Math.abs(rect.x + rect.width / 2 - innerWidth / 2), dy: Math.abs(rect.y + rect.height / 2 - innerHeight / 2), blocked: root.inert && root.getAttribute('aria-busy') === 'true', background: getComputedStyle(document.getElementById('startup-screen')).backgroundColor, filter: getComputedStyle(logo).filter };
        })()`);
        if (!measured.loaded || !measured.blocked || measured.dx > 1 || measured.dy > 1 || measured.background !== (theme === 'dark' ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)') || (theme === 'dark' && measured.filter !== 'invert(1)')) throw new Error(`${theme} splash layout: ${JSON.stringify(measured)}`);
        writeFileSync(path.join(results, `loading-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
      checks.push('the centered Jolo logo covers initial loading in light and dark mode');
      release();
      await waitFor("document.getElementById('startup-screen').hidden && !document.getElementById('root').inert && document.querySelector('.board .empty-state')", 'initial data is ready and the board is usable');
      checks.push('loading ends when the initial data is ready');

      held = new Promise(resolve => { release = resolve; });
      await reload();
      await waitFor("document.querySelector('.app') && !document.getElementById('startup-screen').hidden && document.getElementById('root').inert", 'refresh shows loading again');
      release();
      await waitFor("document.getElementById('startup-screen').hidden && !document.getElementById('root').inert", 'refresh finishes loading');
      checks.push('refresh shows the same loading screen and restores interaction afterward');

      failConnection = true;
      await reload();
      await waitFor("document.getElementById('startup-screen').hidden && !document.getElementById('root').inert && document.querySelector('footer')?.textContent.includes('Startup connection fixture unavailable')", 'startup error is visible instead of an endless splash');
      checks.push('a connection failure reveals the interface and its error');
      const report = { measuredAt: new Date().toISOString(), electron: process.versions.electron, checks };
      writeFileSync(path.join(results, 'smoke.json'), JSON.stringify(report, null, 2));
    } finally {
      release();
      bridge.call = call;
      nativeTheme.themeSource = originalTheme;
    }
  };
}
