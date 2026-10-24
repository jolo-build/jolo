import { expect, test } from "bun:test";
import { backgroundStopKey, backgroundStatus } from "../src/tui/background-stop.js";

test("Ctrl+X stops background work, asks before a force stop once a stop left tasks running, and y confirms it", () => {
  // Nothing to stop: the key does nothing.
  expect(backgroundStopKey({ phase: "idle" }, { running: 0, stopping: false })).toEqual({ type: "ignore" });
  // Background work runs: the first press stops it.
  expect(backgroundStopKey({ phase: "idle" }, { running: 2, stopping: false })).toEqual({ type: "stop" });
  // A stop already in flight: pressing again waits.
  expect(backgroundStopKey({ phase: "idle" }, { running: 2, stopping: true })).toEqual({ type: "ignore" });
  // The stop left tasks running: the next press asks, and only y closes the process.
  /** @type {import("../src/tui/background-stop.js").StopState} */
  const left = { phase: "left", result: { requested: 2, stopped: 0, escalated: false } };
  expect(backgroundStopKey(left, { running: 2, stopping: false })).toEqual({ type: "ask" });
  expect(backgroundStopKey({ phase: "asking" }, { running: 2, stopping: false }, "y")).toEqual({ type: "force" });
  expect(backgroundStopKey({ phase: "asking" }, { running: 2, stopping: false }, "Y")).toEqual({ type: "force" });
  expect(backgroundStopKey({ phase: "asking" }, { running: 2, stopping: false }, "n")).toEqual({ type: "cancel" });
  expect(backgroundStopKey({ phase: "asking" }, { running: 2, stopping: false })).toEqual({ type: "cancel" }); // Ctrl+X again
  // Work that started after the stop is not what it was about: a fresh press stops it rather than asking.
  expect(backgroundStopKey(left, { running: 2, stopping: false, newWork: true })).toEqual({ type: "stop" });
});

test("the status line names the stop's outcome and the force-stop question", () => {
  expect(backgroundStatus({ phase: "stopping" })).toBe("Stopping background work…");
  expect(backgroundStatus({ phase: "left", result: { requested: 2, stopped: 2, escalated: false } })).toBe("Stopped 2 background tasks.");
  expect(backgroundStatus({ phase: "left", result: { requested: 1, stopped: 1, escalated: false } })).toBe("Stopped 1 background task.");
  expect(backgroundStatus({ phase: "left", result: { requested: 2, stopped: 0, escalated: false } })).toBe("2 of 2 background tasks did not stop · Ctrl+X again to force stop");
  expect(backgroundStatus({ phase: "left", result: { requested: 2, stopped: 1, escalated: true } })).toBe("1 of 2 background tasks did not stop · Ctrl+X again to force stop");
  expect(backgroundStatus({ phase: "asking" })).toBe("Force stop? This closes Claude's process, ending its background work and any answer in progress · y confirms, any other key cancels");
  expect(backgroundStatus({ phase: "closing" })).toBe("Closing Claude's process…");
  expect(backgroundStatus({ phase: "idle" })).toBeNull();
});
