// Run progress as one line of text. Derived from durable run state and tool
// invocations only, so the terminal client and the desktop describe the same run the same way.
import { RUNNING as BUSY, PROGRESS_LABELS as LABELS } from "@jolo/client/run-state";

/**
 * @param {any} run the newest run, or null before anything has started
 * @param {any[]} tools invocations belonging to that run
 * @param {any} message the run's newest message, used to tell thinking from responding
 */
export function runProgress(run, tools = [], message = null) {
  if (!run) return { busy: false, label: "Ready", symbol: "○", completed: 0 };
  let label = LABELS[run.state] ?? "Working";
  if (run.state === "model" && message?.status === "streaming") label = message.kind === "reasoning" ? "Thinking" : "Responding";
  const current = tools.find((tool) => tool.status === "running");
  if (run.state === "tools" && current) label = `Running ${current.name}`;
  if (run.state === "paused" && run.pauseReason) label += ` · ${run.pauseReason.replaceAll("_", " ")}`;
  return {
    busy: BUSY.has(run.state), label,
    symbol: run.state === "completed" ? "✓" : ["failed", "interrupted"].includes(run.state) ? "!" : ["paused", "awaiting_permission"].includes(run.state) ? "Ⅱ" : "○",
    completed: tools.filter((tool) => tool.status === "ok").length,
  };
}

/** Coarse duration for display; empty when either timestamp is missing or unparseable. */
export function elapsedTime(start, end) {
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
