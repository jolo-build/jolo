export const SIDEBAR_DEFAULT = 194;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_KEY = 'jolo.sidebar';
export const sidebarLimit = viewport => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - 320));
export const sidebarWidth = (width, viewport) => Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarLimit(viewport), Number.isFinite(width) ? width : SIDEBAR_DEFAULT)));
export function readSidebar(storage) {
  try {
    const saved = JSON.parse(storage.getItem(SIDEBAR_KEY));
    return { width: sidebarWidth(saved?.width, Infinity), collapsed: saved?.collapsed === true };
  } catch { return { width: SIDEBAR_DEFAULT, collapsed: false }; }
}
