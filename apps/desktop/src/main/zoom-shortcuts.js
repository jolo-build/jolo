/** Zoom the document that received the keyboard event. Electron's default menu
 * can keep targeting a retained webview after a click in the application.
 * @param {import('electron').WebContents} contents
 * @param {(factor: number) => void} [setZoom]
 */
export function installZoomShortcuts(contents, setZoom = factor => contents.setZoomFactor(factor)) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(input.control || input.meta)) return;
    if (!['+', '=', '-', '0'].includes(input.key)) return;
    // Stop the menu accelerator as well, so it cannot zoom a different document.
    event.preventDefault();
    const factor = input.key === '0' ? 1 : contents.getZoomFactor() * (input.key === '-' ? 1 / 1.2 : 1.2);
    setZoom(Math.max(0.5, Math.min(3, factor)));
  });
}
