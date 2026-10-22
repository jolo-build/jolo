import { expect, test } from "bun:test";
import { readSidebar, sidebarFits, sidebarLimit, sidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_KEY, SIDEBAR_MAX, SIDEBAR_MIN } from "../src/renderer/sidebar-layout.js";

const storage = value => ({ getItem: key => key === SIDEBAR_KEY ? value : null });

test('a width left at the old 194px default takes the new default, and a chosen width stays', () => {
  expect(SIDEBAR_DEFAULT).toBe(256);
  expect(readSidebar(storage(JSON.stringify({ width: 194, collapsed: true })))).toEqual({ width: SIDEBAR_DEFAULT, collapsed: true });
  expect(readSidebar(storage(JSON.stringify({ width: 300, collapsed: false })))).toEqual({ width: 300, collapsed: false });
  expect(readSidebar(storage(null))).toEqual({ width: SIDEBAR_DEFAULT, collapsed: false });
  expect(readSidebar(storage('not json'))).toEqual({ width: SIDEBAR_DEFAULT, collapsed: false });
});

test('the sidebar width stays between its bounds and leaves the workspace room', () => {
  expect(sidebarWidth(10, Infinity)).toBe(SIDEBAR_MIN);
  expect(sidebarWidth(1000, Infinity)).toBe(SIDEBAR_MAX);
  expect(sidebarLimit(1280)).toBe(SIDEBAR_MAX);
  expect(sidebarWidth(SIDEBAR_MAX, 600)).toBe(280);
  expect(sidebarWidth(SIDEBAR_MAX, 400)).toBe(SIDEBAR_MIN);
});

test('a window too narrow for the sidebar and a 320px chat stops pinning it', () => {
  expect(sidebarFits(519)).toBe(false);
  expect(sidebarFits(520)).toBe(true);
});
