/** Reload the application document, including its sidebar and all split panes.
 * The engine is a separate process, so its tasks continue through a UI reload.
 * A focused webview receives its own native keyboard events, so its listener must
 * route the shortcut back to the application WebContents as well.
 * @param {import('electron').WebContents} contents the source of keyboard input
 * @param {import('electron').WebContents} target the application document to reload
 */
export function installReloadShortcuts(contents, target = contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt) return;
    const refresh = input.key === 'F5' && !input.control && !input.meta
      || input.key.toLowerCase() === 'r' && (process.platform === 'darwin' ? input.meta : input.control);
    if (!refresh) return;
    // Prevent both renderer handlers and the default menu accelerator from reloading twice.
    event.preventDefault();
    if (target.isDestroyed()) return;
    if (input.shift) target.reloadIgnoringCache();
    else target.reload();
  });
}
