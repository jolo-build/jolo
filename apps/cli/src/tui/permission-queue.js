// The requests of a chat still waiting on the user, oldest first. More than one can be open at once (a background
// subagent asks while the main thread asks too), and each one shown in turn as the one before it is settled.
const FINISHED = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Whether an event can change the queue. */
export const touchesPermissions = (event) => event.type === "permission.requested" || event.type === "permission.resolved" || (event.type === "run.state" && FINISHED.has(event.payload.state));

/** The queue after a live event: a new request joins the end; a settled one, or one of a finished run, leaves it. */
export function applyPermissionEvent(queue, event) {
  if (event.type === "permission.requested") return queue.some((request) => request.permissionId === event.payload.permissionId) ? queue : [...queue, event.payload];
  const leaving = event.type === "permission.resolved" ? (request) => request.permissionId === event.payload.permissionId
    : event.type === "run.state" && FINISHED.has(event.payload.state) ? (request) => request.runId === event.runId : null;
  // The same queue when nothing leaves, so a chat with nothing to ask is not drawn again for it.
  return leaving && queue.some(leaving) ? queue.filter((request) => !leaving(request)) : queue;
}

export const finished = (state) => FINISHED.has(state);

/**
 * The queue once a session snapshot arrives: any seen live first (one of them may already be shown), then the snapshot's
 * open requests, less any settled since or whose run has finished (a finished run's requests lapse without an event).
 * @param {any[]} queue @param {any[]} pending @param {Set<string>} settled @param {(runId: string) => boolean} [runEnded]
 */
export function seedPermissions(queue, pending, settled, runEnded = () => false) {
  const known = new Set(queue.map((request) => request.permissionId));
  return [...queue, ...pending.filter((request) => !settled.has(request.permissionId) && !known.has(request.permissionId) && !runEnded(request.runId))];
}
