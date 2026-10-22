export const SIDEBAR_DEFAULT = 256;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 400;
// The default was 194px before October 2026. A width still there was never chosen, so it takes the new default.
const OLD_DEFAULT = 194;
export const SIDEBAR_KEY = 'jolo.sidebar';
// The chat keeps at least this much room beside a pinned sidebar.
const PANE_MIN = 320;
export const sidebarLimit = viewport => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - PANE_MIN));
// Narrower than this, even the narrowest pinned sidebar would leave the chat under PANE_MIN.
export const sidebarFits = viewport => viewport >= SIDEBAR_MIN + PANE_MIN;
export const sidebarWidth = (width, viewport) => Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarLimit(viewport), Number.isFinite(width) ? width : SIDEBAR_DEFAULT)));
export function readSidebar(storage) {
  try {
    const saved = JSON.parse(storage.getItem(SIDEBAR_KEY));
    return { width: sidebarWidth(saved?.width === OLD_DEFAULT ? SIDEBAR_DEFAULT : saved?.width, Infinity), collapsed: saved?.collapsed === true };
  } catch { return { width: SIDEBAR_DEFAULT, collapsed: false }; }
}
