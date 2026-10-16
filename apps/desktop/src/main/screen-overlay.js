// What the user sees while an agent holds the screen: a halo and label that follow the real cursor, and
// a banner naming the stop key. A transparent, click-through, always-on-top window over one display,
// excluded from screen captures and hidden for the instant of each agent screenshot, so the agent
// never sees Jolo's own marks. It never takes focus from the app being controlled.

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;cursor:default;user-select:none}
#frame{position:fixed;inset:0;border:3px solid #7055dfcc;border-radius:10px;box-shadow:inset 0 0 24px #7055df55;opacity:0;transition:opacity .25s}
#banner{position:fixed;top:10px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:#7055df;color:#fff;box-shadow:0 2px 10px #0004;white-space:nowrap;opacity:0;transition:opacity .25s}
#banner kbd{font:inherit;padding:0 5px;margin:0 2px;border-radius:4px;background:#fff3}
#cursor{position:fixed;left:0;top:0;width:0;height:0;transition:left .18s ease-out,top .18s ease-out;opacity:0}
#halo{position:absolute;left:-20px;top:-20px;width:40px;height:40px;border-radius:50%;background:#7055df33;border:2px solid #7055df}
#label{position:absolute;left:18px;top:18px;padding:3px 8px;border-radius:6px;background:#7055df;color:#fff;font-size:11px;white-space:nowrap;box-shadow:0 1px 4px #0003}
.ripple{position:absolute;left:-20px;top:-20px;width:40px;height:40px;border-radius:50%;border:3px solid #7055df;animation:r .5s ease-out forwards}
@keyframes r{from{transform:scale(.4);opacity:.9}to{transform:scale(1.8);opacity:0}}
body.on #frame,body.on #banner,body.on #cursor{opacity:1}
@media (prefers-reduced-motion:reduce){#cursor{transition:none}.ripple{animation:none;display:none}}
</style></head><body>
<div id="frame"></div><div id="banner">Jolo is controlling your screen · move the mouse to take over · <kbd>⌥</kbd><kbd>Esc</kbd> to stop</div>
<div id="cursor"><div id="halo"></div><div id="label">Jolo</div></div>
<script>
window.joloOverlay = function (s) {
  document.body.classList.toggle('on', Boolean(s.visible));
  if (s.banner) document.getElementById('banner').textContent = s.banner;
  const c = document.getElementById('cursor');
  if (typeof s.x === 'number' && typeof s.y === 'number') { c.style.left = s.x + 'px'; c.style.top = s.y + 'px'; }
  if (s.label) document.getElementById('label').textContent = s.label;
  if (s.click) { const r = document.createElement('div'); r.className = 'ripple'; c.appendChild(r); setTimeout(() => r.remove(), 600); }
};
</script></body></html>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {{ BrowserWindow: any, log: any }} deps
 */
export function createScreenOverlay({ BrowserWindow, log }) {
  let window = null;
  let bounds = null;
  let ready = null;
  let state = { visible: false };

  const destroy = () => { if (window && !window.isDestroyed()) window.destroy(); window = null; ready = null; };
  const ensure = (display) => {
    const next = display.bounds;
    if (window && !window.isDestroyed() && bounds && next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height) return window;
    destroy();
    bounds = { ...next };
    window = new BrowserWindow({ ...bounds, show: false, frame: false, transparent: true, hasShadow: false, focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, alwaysOnTop: true, enableLargerThanScreen: true, backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false } });
    window.setAlwaysOnTop(true, 'screen-saver');
    // Electron otherwise changes the entire application between foreground and UI-element
    // process types here. That removes Jolo from the Dock and Command-Tab while the screen
    // overlay is in use, even though the main window is still open.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(error => log.warn('screen overlay failed to load', { error: String(error?.message ?? error) }));
    return window;
  };
  const push = async () => {
    if (!window || window.isDestroyed()) return;
    await ready;
    if (!window || window.isDestroyed()) return;
    try { await window.webContents.executeJavaScript(`window.joloOverlay && window.joloOverlay(${JSON.stringify(state)})`, false); } catch { /* feedback is best effort */ }
  };

  return {
    /** Show over `display`, with the cursor mark at a point in global display points. */
    async show(display, patch = {}) {
      ensure(display);
      state = { ...state, ...patch, visible: true };
      if (patch.x !== undefined) state.x = patch.x - bounds.x;
      if (patch.y !== undefined) state.y = patch.y - bounds.y;
      if (!window.isVisible()) window.showInactive();
      await push();
      state.click = false;
    },
    async hide() {
      state = { visible: false };
      await push();
      if (window && !window.isDestroyed()) window.hide();
    },
    /** The agent's own screenshots never include the overlay: capture protection plus a hidden frame. */
    async beforeCapture() {
      if (!window || window.isDestroyed() || !window.isVisible()) return;
      window.setOpacity(0);
      await sleep(60);
    },
    afterCapture() { if (window && !window.isDestroyed()) window.setOpacity(1); },
    destroy,
  };
}
