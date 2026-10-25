import { expect, test } from "bun:test";
import { activityLine, backgroundTasks, formatElapsed, newerActivity, plural } from "../src/activity.js";

const at = (seconds) => new Date(Date.UTC(2026, 9, 24, 12, 0, seconds)).toISOString();
const NOW = Date.UTC(2026, 9, 24, 12, 0, 30);
const task = (taskId, overrides = {}) => ({ taskId, runId: `${taskId}-run`, toolUseId: null, description: taskId, subagentType: null, taskType: "local_bash", workflowName: null, phase: null, backgrounded: true, status: "running", startedAt: at(0), endedAt: null, usage: { totalTokens: null, toolUses: null, durationMs: null }, ...overrides });
const activity = (state, tasks) => ({ state, tasks, truncated: false, updatedAt: at(29) });

test("elapsed time reads as minutes and seconds, hours when it comes to that, and never below zero", () => {
  expect(formatElapsed(5_000)).toBe("00:05");
  expect(formatElapsed(65_000)).toBe("01:05");
  expect(formatElapsed(3_661_000)).toBe("1:01:01");
  expect(formatElapsed(-5)).toBe("00:00");
  expect(plural(1, "task")).toBe("1 task");
  expect(plural(2, "task")).toBe("2 tasks");
});

test("background work is the running tasks kept in the background, and once no turn runs, every running task", () => {
  const working = activity("working", [task("bg"), task("fg", { backgrounded: false }), task("done", { status: "completed" })]);
  expect(backgroundTasks(working).map((t) => t.taskId)).toEqual(["bg"]);
  const after = activity("background", [task("bg"), task("fg", { backgrounded: false }), task("done", { status: "completed" })]);
  expect(backgroundTasks(after).map((t) => t.taskId)).toEqual(["bg", "fg"]);
  expect(backgroundTasks(null)).toEqual([]);
});

test("the status line counts background tasks with their elapsed time, names a running workflow, and is nothing when none runs", () => {
  expect(activityLine(null, { now: NOW })).toBeNull();
  expect(activityLine(activity("idle", [task("done", { status: "completed" })]), { now: NOW })).toBeNull();
  expect(activityLine(activity("background", [task("a", { startedAt: at(10) }), task("b", { startedAt: at(20) })]), { now: NOW })).toEqual({ text: "Background work: 2 tasks · 00:20", running: 2 });
  expect(activityLine(activity("background", [task("a")]), { now: NOW })).toEqual({ text: "Background work: 1 task · 00:30", running: 1 });
  const workflow = task("wf", { taskType: "local_workflow", workflowName: "demo", backgrounded: false, startedAt: at(25) });
  expect(activityLine(activity("background", [workflow]), { now: NOW })).toEqual({ text: "Workflow demo · 00:05", running: 1 });
  expect(activityLine(activity("background", [workflow, task("a")]), { now: NOW })).toEqual({ text: "Workflow demo · 00:05 · 1 other task", running: 2 });
});

test("a read of the activity replaces only an older snapshot than the one events brought meanwhile", () => {
  const older = activity("background", [task("a")]);
  const newer = { ...activity("idle", []), updatedAt: at(45) };
  expect(newerActivity(newer, older)).toBe(newer);
  expect(newerActivity(older, newer)).toBe(newer);
  expect(newerActivity(null, older)).toBe(older);
  expect(newerActivity(older, null)).toBe(older);
});
