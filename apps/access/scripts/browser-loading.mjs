import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the real stylesheet/font and head script while Chromium's network
// interceptor holds or fails downloads. No production timing hooks are needed.
export async function checkLoading(window, origin) {
  await window.loadURL('about:blank');
  const contents = window.webContents;
  const debuggerAPI = contents.debugger;
  debuggerAPI.attach('1.3');
  const command = (method, params = {}) => debuggerAPI.sendCommand(method, params);
  await command('Network.enable');
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  const snapshot = async () => {
    const { result } = await command('Runtime.evaluate', { returnByValue: true, expression: `(() => ({
      body: Boolean(document.body), loading: document.documentElement.hasAttribute('data-assets-loading'),
      visibility: document.body && getComputedStyle(document.body).visibility,
      fontReady: document.fonts.check('400 16px "Inter"'),
      fontStatus: document.fonts.status
    }))()` });
    return result.value;
  };
  const until = async (predicate, description, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${description}`);
  };
  try {
    for (const mode of ['delayed-font', 'failed-font', 'stalled-font', 'missing-script']) {
      let paused;
      const listener = (_event, method, params) => {
        if (method === 'Fetch.requestPaused') paused = params.requestId;
      };
      debuggerAPI.on('message', listener);
      try {
        await command('Fetch.enable', { patterns: [{ urlPattern: mode === 'missing-script' ? '*/theme.js' : '*/assets/inter.woff2' }] });
        const navigation = window.loadURL(origin + '/?loading-check=' + mode);
        // Attach rejection handling immediately while inspecting a pending navigation.
        navigation.catch(() => {});
        await until(() => paused, `${mode}: resource intercepted`);
        if (mode === 'missing-script') {
          await command('Fetch.failRequest', { requestId: paused, errorReason: 'Failed' });
          await navigation;
          assert.equal((await snapshot()).visibility, 'visible', 'Missing startup JavaScript must leave SSR visible');
        } else {
          await until(async () => (await snapshot()).body, `${mode}: document parsed`);
          assert.equal((await snapshot()).visibility, 'hidden', `${mode}: content must wait for the font`);
          if (mode === 'stalled-font') {
            await until(async () => (await snapshot()).visibility === 'visible', 'Stalled resource fallback', 10000);
            assert.equal((await snapshot()).fontReady, false, 'Fallback must reveal even while the font is unavailable');
          }
          await command(mode === 'failed-font' ? 'Fetch.failRequest' : 'Fetch.continueRequest', {
            requestId: paused, ...(mode === 'failed-font' ? { errorReason: 'Failed' } : {}),
          });
          await navigation;
          await until(async () => (await snapshot()).visibility === 'visible', `${mode}: content revealed`);
          // After the stalled-download fallback, visibility no longer signals font readiness.
          // Navigation can also finish before Chromium has decoded the resumed font.
          await until(async () => (await snapshot()).fontStatus === 'loaded', `${mode}: font loading settled`);
          const state = await snapshot();
          assert.equal(state.loading, false);
          assert.equal(state.fontReady, mode !== 'failed-font', `${mode}: expected font availability`);
        }
      } finally {
        await command('Fetch.disable');
        debuggerAPI.off('message', listener);
      }
    }
    console.log('Access startup passed: delayed font, failed font, stalled download, and missing JavaScript.');
  } finally {
    debuggerAPI.detach();
  }
}
