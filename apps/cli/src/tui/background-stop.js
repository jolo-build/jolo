// Stopping a conversation's background work from the terminal client: what Ctrl+X does at each point (stop, then ask
// before a force stop once a stop left tasks running, which only y confirms), and what the status line says of it.
import { plural } from "@jolo/client/activity";

/**
 * @typedef {{ requested: number, stopped: number, escalated: boolean }} StopResult
 * @typedef {{ phase: "idle" | "stopping" | "left" | "asking" | "closing", result?: StopResult, taskIds?: string[] }} StopState
 * `left`: a stop was answered and may have left tasks running (`taskIds` are the ones it was sent for); `asking`: the
 * force-stop question is up, and the next key answers it.
 * @typedef {{ type: "ignore" | "stop" | "ask" | "cancel" | "force" }} StopAction
 */

/**
 * What a press of Ctrl+X (or, while asking, any key) does.
 * @param {StopState} stop @param {{ running: number, stopping: boolean, newWork?: boolean }} work the background tasks
 *   running now, whether a stop or close is in flight, and whether the running work started after the last stop (then it is
 *   not what that stop was about, and a fresh stop is due rather than a force stop)
 * @param {string} [chunk] the key pressed while asking
 * @returns {StopAction}
 */
export function backgroundStopKey(stop, { running, stopping, newWork = false }, chunk = "") {
  if (stop.phase === "asking") return { type: /^y$/i.test(chunk) ? "force" : "cancel" };
  if (stopping || stop.phase === "stopping" || stop.phase === "closing" || !running) return { type: "ignore" };
  if (stop.phase === "left" && !newWork) return { type: "ask" };
  return { type: "stop" };
}

/** The status line for the stop's state; null when there is nothing to say. @param {StopState} stop */
export function backgroundStatus(stop) {
  if (stop.phase === "stopping") return "Stopping background work…";
  if (stop.phase === "closing") return "Closing Claude's process…";
  if (stop.phase === "asking") return "Force stop? This closes Claude's process, ending its background work and any answer in progress · y confirms, any other key cancels";
  if (stop.phase === "left" && stop.result) {
    const { requested, stopped, escalated } = stop.result;
    const left = requested - stopped;
    if (!left && !escalated) return `Stopped ${plural(stopped, "background task")}.`;
    return `${left || requested} of ${plural(requested, "background task")} did not stop · Ctrl+X again to force stop`;
  }
  return null;
}
