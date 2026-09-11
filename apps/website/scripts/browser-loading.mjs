import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

app.setPath('userData', process.env.JOLO_WEBSITE_TEST_HOME);
app.setPath('logs', path.join(process.env.JOLO_WEBSITE_TEST_HOME, 'logs'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Let Electron finish loading this entry module before waiting for app readiness.
let phase = 'starting Electron';
const timeout = setTimeout(() => { console.error(`Website loading checks timed out: ${phase}`); app.exit(1); }, 60000);
async function checkLoading() {
  app.dock?.hide();
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } });
  phase = 'initial blank page';
  await window.loadURL('about:blank');
  const debuggerAPI = window.webContents.debugger;
  debuggerAPI.attach('1.3');
  const command = (method, params = {}) => debuggerAPI.sendCommand(method, params);
  const evaluate = async expression => (await command('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const snapshot = () => evaluate(`(() => ({
    parsed: !!document.getElementById('root')?.children.length,
    loading: document.documentElement.hasAttribute('data-assets-loading'),
    error: document.documentElement.hasAttribute('data-assets-error'),
    visible: document.getElementById('root') && getComputedStyle(document.getElementById('root')).visibility === 'visible',
    fontReady: document.fonts.check('400 16px "JetBrains Mono"'),
    stylesReady: [...document.querySelectorAll('link[rel="stylesheet"]')].every(link => !!link.sheet),
    loader: !!document.getElementById('startup')
  }))()`);
  const until = async (predicate, label, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const origin = process.env.JOLO_WEBSITE_TEST_ORIGIN;
  try {
    await command('Network.enable');
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    for (const [resource, pattern] of [['font', '*.woff2'], ['stylesheet', '*.css'], ['script', '*/assets/*.js']]) {
      for (const mode of ['delayed', 'failed']) {
        phase = `${mode} ${resource}`;
        await window.loadURL('about:blank');
        const paused = [];
        let failFurther = false, releasing = false;
        const listener = (_event, method, params) => {
          if (method !== 'Fetch.requestPaused') return;
          if (releasing) void command(failFurther ? 'Fetch.failRequest' : 'Fetch.continueRequest', {
            requestId: params.requestId, ...(failFurther ? { errorReason: 'Failed' } : {}),
          });
          else paused.push(params.requestId);
        };
        debuggerAPI.on('message', listener);
        await command('Fetch.enable', { patterns: [{ urlPattern: pattern }] });
        const navigation = window.loadURL(`${origin}/?${mode}-${resource}`);
        navigation.catch(() => {});
        try {
          await until(() => paused.length, `${resource} intercepted`);
          await until(async () => (await snapshot()).parsed, 'Prerendered HTML parsed');
          await delay(300);
          let state = await snapshot();
          assert.equal(state.loading, true);
          assert.equal(state.visible, false, `Content must stay hidden during ${mode} ${resource}`);
          failFurther = mode === 'failed';
          releasing = true;
          while (paused.length) await command(failFurther ? 'Fetch.failRequest' : 'Fetch.continueRequest', {
            requestId: paused.shift(), ...(failFurther ? { errorReason: 'Failed' } : {}),
          });
          phase = `${mode} ${resource} navigation`;
          await navigation;
          await until(async () => { const next = await snapshot(); return failFurther ? next.error : next.visible; }, `${mode} ${resource} settled`);
          state = await snapshot();
          if (failFurther) {
            assert.equal(state.visible, false, `Failed ${resource} must not reveal a broken page`);
            assert.equal(await evaluate('getComputedStyle(document.querySelector("#startup button")).display'), 'block');
            await command('Fetch.disable');
            const retry = once(window.webContents, 'did-finish-load');
            await evaluate('document.querySelector("#startup button").click()');
            await retry;
            await until(async () => (await snapshot()).visible, 'Retry loads the complete page');
          } else {
            assert.equal(state.loading, false);
            assert.equal(state.loader, false);
            assert.equal(state.fontReady, true);
            assert.equal(state.stylesReady, true);
            await evaluate('document.getElementById("tab-desktop").click()');
            await until(() => evaluate('document.getElementById("tab-desktop").getAttribute("aria-selected") === "true"'), 'Controls work immediately');
          }
          console.log(`Website startup passed: ${mode} ${resource}.`);
        } finally {
          await command('Fetch.disable');
          debuggerAPI.off('message', listener);
        }
      }
    }
    // The timeout offers recovery without revealing fallback fonts. A late
    // successful download can still finish normally without reloading.
    await window.loadURL('about:blank');
    phase = 'stalled font';
    let stalled;
    const listener = (_event, method, params) => { if (method === 'Fetch.requestPaused') stalled = params.requestId; };
    debuggerAPI.on('message', listener);
    await command('Fetch.enable', { patterns: [{ urlPattern: '*.woff2' }] });
    const navigation = window.loadURL(origin + '/?stalled');
    navigation.catch(() => {});
    await until(() => stalled, 'Stalled font intercepted');
    await until(async () => (await snapshot()).error, 'Stalled download retry', 17000);
    assert.equal((await snapshot()).visible, false);
    await command('Fetch.continueRequest', { requestId: stalled });
    await command('Fetch.disable');
    await navigation;
    await until(async () => (await snapshot()).visible, 'Late download recovery');
    debuggerAPI.off('message', listener);
    console.log('Website startup passed: stalled download remains hidden and recovers when loaded.');

    // A warm cache also reveals normally.
    await command('Network.setCacheDisabled', { cacheDisabled: false });
    phase = 'cached and mobile visits';
    await window.loadURL(origin);
    await until(async () => (await snapshot()).visible, 'Cached visit');
    if (process.env.JOLO_WEBSITE_SCREENSHOT_DIR) await writeFile(path.join(process.env.JOLO_WEBSITE_SCREENSHOT_DIR, 'jolo-website-ready.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 844);
    await window.loadURL(origin);
    await until(async () => (await snapshot()).visible, 'Mobile visit');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    if (process.env.JOLO_WEBSITE_SCREENSHOT_DIR) await writeFile(path.join(process.env.JOLO_WEBSITE_SCREENSHOT_DIR, 'jolo-website-ready-mobile.png'), (await window.webContents.capturePage()).toPNG());
    await command('Emulation.setScriptExecutionDisabled', { value: true });
    phase = 'no JavaScript';
    await window.loadURL(origin);
    assert.equal((await snapshot()).visible, true, 'No JavaScript preserves the static page');
    console.log('Website startup passed: cached visit, mobile layout, and no JavaScript.');
    debuggerAPI.detach();
    window.destroy();
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
}
app.whenReady().then(checkLoading).catch(error => { console.error(error); app.exit(1); });
