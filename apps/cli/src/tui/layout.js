// Terminal geometry for the interactive client. Chrome keeps a fixed number of rows;
// the transcript takes what is left, and scrolling never leaves the composer or the footer off screen.
/**
 * Rows each region may occupy at this size.
 * @param {{ columns?: number, rows?: number, permission?: boolean, changes?: boolean }} size
 * @returns {{ columns: number, rows: number, tooSmall: boolean, gapRows: number, compactPermission: boolean, permissionRows: number, changesRows: number, contentRows: number }}
 */
export function terminalLayout({ columns = 80, rows = 24, permission = false, changes = false }) {
  columns = Math.max(1, Math.floor(columns));
  rows = Math.max(1, Math.floor(rows));
  const tooSmall = columns < 32 || rows < (permission ? 10 : 8);
  const gapRows = rows >= 16 ? 1 : 0;
  const compactPermission = rows < 12;
  const permissionRows = permission ? compactPermission ? 3 : 6 : 0;
  const changesRows = changes && rows >= 16 ? 1 : 0;
  // Header, progress, three-row composer, and footer always remain in the viewport.
  const contentRows = tooSmall ? 0 : Math.max(0, rows - 6 - gapRows - permissionRows - changesRows);
  return { columns, rows, tooSmall, gapRows, compactPermission, permissionRows, changesRows, contentRows };
}

/** Move the viewport by `delta` lines; returns null once it reaches the newest line, meaning "follow live". */
export function scrollHistory(lines, height, top, delta) {
  const { start, lastStart } = historyViewport(lines, height, top);
  const next = Math.max(0, Math.min(lastStart, start + delta));
  return next >= lastStart ? null : next;
}

/** The slice of `lines` visible at `top`, clamped to the transcript; `top` of null follows the newest line. */
export function historyViewport(lines, height, top = null) {
  const count = Math.max(0, height);
  const lastStart = Math.max(0, lines.length - count);
  const start = top === null ? lastStart : Math.max(0, Math.min(top, lastStart));
  return { lines: lines.slice(start, start + count), start, lastStart };
}
