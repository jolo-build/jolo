// Dependency-free lifecycle vocabulary for engines and renderers.
export const RUN_STATES = Object.freeze([
  "queued",
  "preparing",
  "model",
  "tools",
  "awaiting_permission",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "interrupted",
]);
export const TERMINAL_RUN_STATES = Object.freeze(["cancelled", "completed", "failed", "interrupted"]);

export const WORKING_RUN_STATES = Object.freeze(RUN_STATES.filter(state => !TERMINAL_RUN_STATES.includes(state) && state !== "paused" && state !== "awaiting_permission"));
