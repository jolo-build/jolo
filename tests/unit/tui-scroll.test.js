import { expect, test } from "bun:test";
import { createWheelScroller } from "../../apps/cli/src/tui/scroll.js";

function fixture() {
  const view = { lines: Array.from({ length: 100 }, (_, i) => i), height: 10, top: null };
  const writes = [];
  let pending;
  const scroller = createWheelScroller({
    read: () => view,
    write: (top) => { writes.push(top); view.top = top; },
    schedule: (callback) => { pending = callback; return 1; },
    cancel: () => { pending = null; },
  });
  return { scroller, view, writes, frame: () => { const callback = pending; pending = null; callback?.(); } };
}

test("rapid wheel packets produce one redraw per frame without dropping scroll distance", () => {
  const { scroller, writes, frame } = fixture();
  for (let i = 0; i < 10; i++) scroller.push(-5);
  expect(writes).toEqual([]);
  frame();
  expect(writes).toEqual([40]);
  scroller.push(5); scroller.push(5); frame();
  expect(writes).toEqual([40, 50]);
});

test("direction changes at either boundary are preserved within a burst", () => {
  const { scroller, writes, frame } = fixture();
  scroller.push(5); scroller.push(-5); frame();
  expect(writes.at(-1)).toBe(85);
  scroller.push(-200); scroller.push(5); frame();
  expect(writes.at(-1)).toBe(5);
  scroller.push(200); frame();
  expect(writes.at(-1)).toBeNull();
});

test("resize, navigation, and exit can cancel stale wheel work", () => {
  const { scroller, view, writes, frame } = fixture();
  scroller.push(-5); scroller.cancel(); frame();
  expect(writes).toEqual([]);
  view.height = 20;
  scroller.push(-5); frame();
  expect(writes).toEqual([75]);
});
