// Questions an agent asks the person (dialogs): recorded, published, and settled once, by an answer, a dismissal, or
// the wait for them ending (a Stop, or the agent taking the question back).
import { ProtocolError } from "@jolo/protocol";

/** @param {{ storage: any }} deps */
export function createDialogService({ storage }) {
  /** Who waits on each open dialog, by dialog id; it lives in memory, as the agent that asked does. */
  const waiters = new Map();

  const settle = (dialogId, state, response = null) => {
    const dialog = storage.transaction(() => {
      const current = storage.dialogs.get(dialogId);
      if (!current) throw new ProtocolError("not_found", "unknown dialog");
      const settled = storage.dialogs.settle(dialogId, { state, response });
      if (!settled) throw new ProtocolError("conflict", `dialog already ${current.state}`, { state: current.state });
      storage.appendEvent({ sessionId: settled.sessionId, runId: settled.runId, type: "dialog.resolved", payload: { dialogId, state } });
      return settled;
    });
    waiters.get(dialogId)?.(dialog);
    return dialog;
  };

  // A dialog left open by an earlier engine can never be answered: the process that asked it is gone.
  for (const stale of storage.dialogs.requested()) settle(stale.id, "cancelled");

  return {
    /** @param {{ run: any, requestId: string, tool: string, toolUseId?: string | null, input: Record<string, unknown> }} request */
    request({ run, requestId, tool, toolUseId = null, input }) {
      return storage.transaction(() => {
        const dialog = storage.dialogs.insert({ sessionId: run.sessionId, runId: run.id, requestId, tool, toolUseId, input });
        storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "dialog.requested", payload: { dialogId: dialog.id, runId: run.id, tool, input, toolUseId } });
        return dialog;
      });
    },
    get: (dialogId) => storage.dialogs.get(dialogId),
    /** The settled dialog; rejects once `signal` aborts, after marking the dialog cancelled. */
    waitForResolution(dialogId, signal) {
      return new Promise((resolve, reject) => {
        const current = storage.dialogs.get(dialogId);
        if (!current) return reject(new ProtocolError("not_found", "unknown dialog"));
        if (current.state !== "requested") return resolve(current);
        const cleanup = () => { waiters.delete(dialogId); signal.removeEventListener("abort", onAbort); };
        const onAbort = () => {
          cleanup();
          try { settle(dialogId, "cancelled"); } catch (error) { if (error?.code !== "conflict") return reject(error); } // settled meanwhile
          reject(new ProtocolError("interrupted", "the dialog was closed before the person answered"));
        };
        if (signal.aborted) return onAbort();
        waiters.set(dialogId, (dialog) => { cleanup(); resolve(dialog); });
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    resolve: (dialogId, response) => settle(dialogId, "answered", response),
    dismiss: (dialogId, message) => settle(dialogId, "dismissed", { message }),
    cancel: (dialogId) => settle(dialogId, "cancelled"),
  };
}
