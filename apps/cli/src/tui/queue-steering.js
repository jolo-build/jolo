// Keep the request promise so a second Enter can arrive before run.start replies.
export function createQueueSteering(sendNow, now = Date.now) {
  let pending = null;
  return {
    remember(operation, draft) { pending = { operation, draft, at: now() }; },
    clear() { pending = null; },
    steer(draft) {
      const queued = pending;
      pending = null;
      if (!queued || now() - queued.at > 500 || (draft.trim() && draft !== queued.draft)) return null;
      return Promise.resolve(queued.operation).then(run => sendNow(run.id));
    },
  };
}
