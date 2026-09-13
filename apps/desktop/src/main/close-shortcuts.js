/** Route close through the panel hierarchy even when a native webview has focus.
 * @param {import('electron').WebContents} contents
 * @param {import('electron').WebContents} target
 */
export function installCloseShortcuts(contents, target = contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || input.shift || input.key.toLowerCase() !== 'w') return;
    if (process.platform === 'darwin' ? !input.meta || input.control : !input.control || input.meta) return;
    // Suppress the default window-close accelerator and held-key repeats.
    event.preventDefault();
    if (!input.isAutoRepeat && !target.isDestroyed()) target.send('jolo:closeRequest', { fromBrowser: contents !== target });
  });
}
