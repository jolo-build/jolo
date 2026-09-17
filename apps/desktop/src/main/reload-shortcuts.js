/** Reload the document selected by the focused panel. A webview receives native
 * keyboard events separately from the application and its browser address bar.
 * @param {import('electron').WebContents} contents the source of keyboard input
 * @param {() => import('electron').WebContents | Promise<import('electron').WebContents>} [getTarget]
 */
export function installReloadShortcuts(contents, getTarget = () => contents) {
  contents.on('before-input-event', async (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    const refresh = input.key === 'F5' && !input.control && !input.meta
      || input.key.toLowerCase() === 'r' && (process.platform === 'darwin' ? input.meta : input.control);
    if (!refresh) return;
    // Prevent both renderer handlers and the default menu accelerator from reloading twice.
    event.preventDefault();
    if (input.isAutoRepeat) return;
    const target = await getTarget();
    if (target.isDestroyed()) return;
    if (input.shift) target.reloadIgnoringCache();
    else target.reload();
  });
}
