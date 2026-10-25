// The requests of a chat still waiting on the user, oldest first: permission requests and Claude's dialogs (a question,
// a plan to approve), one queue. More than one can be open at once (a background subagent asks while the main thread asks
// too), and each one is shown in turn as the one before it is settled.
const FINISHED = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** A request's id: a permission's, or a dialog's. */
export const requestKey = (request) => request.permissionId ?? request.dialogId;
/** Whether a request is one of Claude's dialogs rather than a permission request. */
export const isDialog = (request) => Boolean(request) && !("permissionId" in request) && "dialogId" in request;

/** Whether an event can change the queue. */
export const touchesPermissions = (event) => event.type === "permission.requested" || event.type === "permission.resolved" || event.type === "dialog.requested" || event.type === "dialog.resolved" || (event.type === "run.state" && FINISHED.has(event.payload.state));

/** The queue after a live event: a new request joins the end; a settled one, or one of a finished run, leaves it. */
export function applyPermissionEvent(queue, event) {
  if (event.type === "permission.requested" || event.type === "dialog.requested") return queue.some((request) => requestKey(request) === requestKey(event.payload)) ? queue : [...queue, event.payload];
  const leaving = event.type === "permission.resolved" || event.type === "dialog.resolved" ? (request) => requestKey(request) === requestKey(event.payload)
    : event.type === "run.state" && FINISHED.has(event.payload.state) ? (request) => request.runId === event.runId : null;
  // The same queue when nothing leaves, so a chat with nothing to ask is not drawn again for it.
  return leaving && queue.some(leaving) ? queue.filter((request) => !leaving(request)) : queue;
}

export const finished = (state) => FINISHED.has(state);

/**
 * The queue once a session snapshot arrives: any seen live first (one of them may already be shown), then the snapshot's
 * open requests (its permission requests, then its dialogs), less any settled since or whose run has finished (a
 * finished run's requests lapse without an event).
 * @param {any[]} queue @param {any[]} pending @param {Set<string>} settled @param {(runId: string) => boolean} [runEnded]
 */
export function seedPermissions(queue, pending, settled, runEnded = () => false) {
  const known = new Set(queue.map(requestKey));
  return [...queue, ...pending.filter((request) => !settled.has(requestKey(request)) && !known.has(requestKey(request)) && !runEnded(request.runId))];
}
