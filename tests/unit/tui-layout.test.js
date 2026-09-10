import { expect, test } from "bun:test";
import { terminalLayout, historyViewport, scrollHistory } from "../../apps/cli/src/tui/layout.js";

test("every supported terminal size reserves exactly enough space for prompt, progress, and footer", () => {
  for (const columns of [32, 40, 80, 160]) for (const rows of [8, 10, 11, 12, 15, 16, 24, 60]) {
    for (const permission of [false, true]) for (const changes of [false, true]) {
      const layout = terminalLayout({ columns, rows, permission, changes });
      if (layout.tooSmall) continue;
      expect(6 + layout.gapRows + layout.contentRows + layout.permissionRows + layout.changesRows).toBe(rows);
      expect(layout.contentRows).toBeGreaterThanOrEqual(0);
    }
  }
});

test("tiny viewports keep their actual dimensions instead of overflowing with a minimum size", () => {
  expect(terminalLayout({ columns: 20, rows: 4 })).toMatchObject({ columns: 20, rows: 4, tooSmall: true, contentRows: 0 });
  expect(terminalLayout({ columns: 80, rows: 8, permission: true }).tooSmall).toBe(true);
});

test("history follows new output until the user scrolls up", () => {
  const lines = Array.from({ length: 50 }, (_, i) => i);
  expect(historyViewport(lines, 10).lines).toEqual(lines.slice(40));
  const top = scrollHistory(lines, 10, null, -9);
  expect(top).toBe(31);
  expect(historyViewport([...lines, 50, 51], 10, top).lines).toEqual(lines.slice(31, 41));
  expect(scrollHistory(lines, 10, top, 9)).toBeNull();
});

test("scrolling and resize clamp both ends, including short and empty histories", () => {
  const lines = Array.from({ length: 50 }, (_, i) => i);
  expect(scrollHistory(lines, 10, null, -100)).toBe(0);
  expect(scrollHistory(lines, 10, 0, 100)).toBeNull();
  expect(historyViewport(lines, 30, 40)).toMatchObject({ start: 20, lastStart: 20, lines: lines.slice(20) });
  expect(historyViewport(lines, 0).lines).toEqual([]);
  expect(historyViewport([], 20).lines).toEqual([]);
  expect(scrollHistory([1, 2], 20, null, -3)).toBeNull();
});
