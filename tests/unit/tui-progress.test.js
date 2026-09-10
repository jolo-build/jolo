import { expect, test } from "bun:test";
import { runProgress, elapsedTime } from "../../apps/cli/src/tui/progress.js";

test("progress reflects actual model and tool activity", () => {
  expect(runProgress(null)).toMatchObject({ busy: false, label: "Ready" });
  expect(runProgress({ state: "model" })).toMatchObject({ busy: true, label: "Thinking" });
  expect(runProgress({ state: "model" }, [], { status: "streaming", kind: "text" }).label).toBe("Responding");
  expect(runProgress({ state: "model" }, [], { status: "streaming", kind: "reasoning" }).label).toBe("Thinking");
  expect(runProgress({ state: "tools" }, [{ name: "read_file", status: "ok" }, { name: "run_command", status: "running" }, { status: "error" }])).toMatchObject({ busy: true, label: "Running run_command", completed: 1 });
});

test("paused and terminal states stop the spinner and display the correct outcome", () => {
  expect(runProgress({ state: "awaiting_permission" })).toMatchObject({ busy: false, label: "Waiting for approval" });
  expect(runProgress({ state: "paused", pauseReason: "budget" })).toMatchObject({ busy: false, label: "Paused · budget" });
  expect(runProgress({ state: "completed" })).toMatchObject({ busy: false, label: "Completed", symbol: "✓" });
  for (const state of ["cancelled", "failed", "interrupted"]) expect(runProgress({ state }).busy).toBe(false);
});

test("elapsed duration is readable and tolerates missing timestamps and clock changes", () => {
  const start = "2026-09-08T00:00:00.000Z";
  expect(elapsedTime(start, "2026-09-08T00:00:08.999Z")).toBe("8s");
  expect(elapsedTime(start, "2026-09-08T00:01:05.000Z")).toBe("1m 5s");
  expect(elapsedTime(start, "2026-09-08T02:30:05.000Z")).toBe("2h 30m");
  expect(elapsedTime(start, "2026-09-07T23:59:59.000Z")).toBe("0s");
  expect(elapsedTime(undefined, start)).toBe("");
});
