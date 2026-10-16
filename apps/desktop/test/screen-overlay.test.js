import { expect, test } from 'bun:test';
import { createScreenOverlay } from '../src/main/screen-overlay.js';

test('the macOS overlay does not remove the application from the Dock or Command-Tab', async () => {
  let options = null;
  let workspaceOptions = null;
  class Window {
    constructor(next) {
      options = next;
      this.visible = false;
      this.destroyed = false;
      this.webContents = { on() {}, setWindowOpenHandler() {}, async executeJavaScript() {} };
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(_visible, next) { workspaceOptions = next; }
    setIgnoreMouseEvents() {}
    setContentProtection() {}
    async loadURL() {}
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    isDestroyed() { return this.destroyed; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; }
  }
  const overlay = createScreenOverlay({ BrowserWindow: Window, log: { warn() {} } });
  await overlay.show({ bounds: { x: 0, y: 0, width: 1440, height: 900 } });
  expect(options).toMatchObject({ focusable: false, alwaysOnTop: true, show: false });
  expect(options).not.toHaveProperty('skipTaskbar');
  expect(workspaceOptions).toEqual({ visibleOnFullScreen: true, skipTransformProcessType: true });
  overlay.destroy();
});
