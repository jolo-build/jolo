import { expect, test } from "bun:test";
import { initialLayout, MAX_PANES, paneRects, paneReducer } from "../src/renderer/pane-layout.js";
import { taskDropSide } from '../src/renderer/task-drag.jsx';

test('task drops place an existing chat on every edge without replacing its target', () => {
  const task = { rootPath: '/other', session: { id: 'existing' }, historyState: 'archived' };
  const bounds = { left: 200, top: 100, width: 800, height: 600 };
  // Each case is a drop point, the edge it should land on, and the rect that edge gives the new pane.
  // The tuple type is spelled out because the rows are mixed, and without it every element would be
  // the union of all four column types.
  for (const [x, y, side, expected] of /** @type {[number, number, string, { x: number, y: number, width: number, height: number }][]} */ ([
    [210, 400, 'left', { x: 0, y: 0, width: 50, height: 100 }],
    [990, 400, 'right', { x: 50, y: 0, width: 50, height: 100 }],
    [600, 110, 'top', { x: 0, y: 0, width: 100, height: 50 }],
    [600, 690, 'bottom', { x: 0, y: 50, width: 100, height: 50 }],
  ])) {
    expect(taskDropSide(x, y, bounds)).toBe(side);
    const initial = initialLayout();
    const state = paneReducer(initial, { type: 'split', source: 'pane-1', id: 'new', axis: ['top', 'bottom'].includes(side) ? 'y' : 'x', before: ['left', 'top'].includes(side), task });
    expect(state.panes[0]).toBe(initial.panes[0]);
    expect(state.panes[1].task).toBe(task);
    expect(paneRects(state.tree).panes.new).toEqual(expected);
  }
  expect(taskDropSide(600, 400, bounds)).toBe('right');
});

test("nested splits tile the workspace without overlap and preserve existing pane identities", () => {
  let state = initialLayout();
  const original = state.panes[0];
  state = paneReducer(state, { type: "split", source: "pane-1", id: "pane-2", axis: "x", path: "/repo" });
  state = paneReducer(state, { type: "split", source: "pane-2", id: "pane-3", axis: "y", path: "/other" });
  expect(state.panes[0]).toBe(original);
  expect(state.active).toBe("pane-3");
  const rects = paneRects(state.tree);
  expect(rects.panes).toEqual({ "pane-1": { x: 0, y: 0, width: 50, height: 100 }, "pane-2": { x: 50, y: 0, width: 50, height: 50 }, "pane-3": { x: 50, y: 50, width: 50, height: 50 } });
  expect(Object.values(rects.panes).reduce((sum, rect) => sum + rect.width * rect.height, 0)).toBe(10000);
});

test("closing a split collapses its parent and retains the sibling's conversation identity", () => {
  let state = paneReducer(initialLayout(), { type: "split", source: "pane-1", id: "pane-2", axis: "x" });
  state = paneReducer(state, { type: "split", source: "pane-2", id: "pane-3", axis: "y" });
  state = paneReducer(state, { type: "zoom", id: "pane-3" });
  const survivor = state.panes[1];
  state = paneReducer(state, { type: "close", id: "pane-3" });
  expect(state.zoom).toBeNull();
  expect(state.active).toBe("pane-2");
  expect(state.panes[1]).toBe(survivor);
  expect(paneRects(state.tree).panes["pane-2"]).toEqual({ x: 50, y: 0, width: 50, height: 100 });
  state = paneReducer(state, { type: "close", id: "pane-1" });
  expect(state.tree).toEqual({ id: "pane-2" });
  expect(paneReducer(state, { type: "close", id: "pane-2" })).toBe(state);
});

test("resize and zoom preserve pane state and reject invalid geometry", () => {
  let state = paneReducer(initialLayout(), { type: "split", source: "pane-1", id: "pane-2", axis: "x" });
  const panes = state.panes;
  state = paneReducer(state, { type: "resize", id: state.tree.id, ratio: 4 });
  expect(state.tree.ratio).toBe(.85);
  expect(state.panes).toBe(panes);
  expect(paneReducer(state, { type: "resize", id: state.tree.id, ratio: NaN })).toBe(state);
  const tree = state.tree;
  state = paneReducer(state, { type: "zoom", id: "pane-1" });
  expect(state.tree).toBe(tree);
  expect(state.zoom).toBe("pane-1");
  state = paneReducer(state, { type: "zoom", id: "pane-1" });
  expect(state.zoom).toBeNull();
});

test("pane limits and stale actions cannot orphan or duplicate conversations", () => {
  let state = initialLayout();
  for (let i = 2; i <= MAX_PANES; i++) state = paneReducer(state, { type: "split", source: "pane-1", id: `pane-${i}`, axis: "x" });
  expect(state.panes.length).toBe(MAX_PANES);
  expect(Object.keys(paneRects(state.tree).panes).length).toBe(MAX_PANES);
  for (const action of [{ type: "split", source: "pane-1", id: "extra" }, { type: "close", id: "missing" }, { type: "focus", id: "missing" }, { type: "zoom", id: "missing" }]) expect(paneReducer(state, action)).toBe(state);
});
