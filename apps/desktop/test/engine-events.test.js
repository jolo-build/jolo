import { afterAll, expect, test } from "bun:test";

/** @type {(items: any[], meta?: any) => void} */
let captured = () => {};
// The module reads the preload bridge when a pane first subscribes, so the stub must exist before it loads.
// Bun shares globals across test files, so the original is put back afterwards.
const original = globalThis.window;
afterAll(() => { globalThis.window = original; });
globalThis.window = /** @type {any} */ ({ jolo: { onEvents: (/** @type {(items: any[], meta?: any) => void} */ listener) => { captured = listener; return () => {}; } } });
const { subscribePaneEvents } = await import("../src/renderer/engine-events.js");

test("a pane receives only its own conversation's activity ticks, in order with events", () => {
  const received = { a: [], b: [] };
  const stopA = subscribePaneEvents(() => "a", (items) => received.a.push(...items));
  const stopB = subscribePaneEvents(() => "b", (items) => received.b.push(...items));
  try {
    const activity = { state: "background", tasks: [], truncated: false, updatedAt: "x" };
    const tick = { kind: "activity", value: { sessionId: "a", activity } };
    const event = { kind: "event", value: { type: "run.state", sessionId: "a" } };
    captured([tick, event]);
    expect(received.a).toEqual([tick, event]);
    expect(received.b).toEqual([event]);
  } finally { stopA(); stopB(); }
});
