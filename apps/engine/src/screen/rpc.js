import { ProtocolError } from '@jolo/protocol';
import { newId } from '../storage/index.js';
import { readResultImages } from '../attachments.js';

// A hosted MCP call must answer within the bridge's request timeout, so a consent wait is bounded
// and the agent is told to call again while the user is still deciding.
const CONSENT_WAIT_MS = 50_000;

/**
 * Screen access for hosted agents. The run comes from the credential, never from the model, and the
 * same per-task consent applies: the first call waits for the user's decision in Jolo desktop.
 */
export function screenCallHandler({ storage, runs, dispatcher, permissions, settingsService, interactiveClients }) {
  const pending = new Map();
  return async ({ workspaceId, name, arguments: args }, conn) => {
    const runId = conn.capability?.runId;
    const active = runs.active.get(runId);
    const run = runId && storage.getRun(runId);
    const session = run && storage.getSession(run.sessionId);
    if (!active || active.controller.signal.aborted || session?.workspaceId !== workspaceId || conn.capability.workspaceId !== workspaceId) throw new ProtocolError('permission_denied', 'screen tools require a live run credential for this workspace');
    const tool = dispatcher.registry.get(name);
    if (!tool?.screenOperation) throw new ProtocolError('invalid_params', 'unknown screen tool');
    const workspace = storage.getWorkspace(workspaceId);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    conn.closeHooks.add(cancel);
    active.controller.signal.addEventListener('abort', cancel, { once: true });
    // One screen, one action at a time: an agent that issues several screen calls in one turn has
    // them run in order rather than refused.
    const previous = pending.get(runId) ?? Promise.resolve();
    /** @type {(value?: unknown) => void} */
    let unlock = () => {};
    const gate = new Promise(resolve => { unlock = resolve; });
    const turn = previous.then(() => gate);
    pending.set(runId, turn);
    const answer = (value, isError) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });
    try {
      await previous;
      controller.signal.throwIfAborted();
      for (;;) {
        const waiting = permissions.pendingScreenRequest(runId);
        if (waiting) {
          if (interactiveClients() === 0) return answer({ ok: false, error: { code: 'permission_required', message: 'Screen control needs approval in Jolo desktop, and no Jolo window is open' } }, true);
          const timeout = AbortSignal.timeout(CONSENT_WAIT_MS);
          let decided;
          try { decided = await permissions.waitForResolution(waiting.id, AbortSignal.any([controller.signal, timeout])); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            return answer({ ok: false, error: { code: 'permission_pending', message: 'The user has not decided yet whether Jolo may control the screen. Call this tool again to keep waiting.' } }, true);
          }
          if (decided.state !== 'allowed') return answer({ ok: false, error: { code: 'permission_denied', message: 'The user declined screen control for this task. Do not ask again in this task.' } }, true);
        }
        const result = await dispatcher.invoke({ run, workspace: { id: workspace.id, root: workspace.path }, call: { callId: newId('screen'), name, arguments: args }, signal: controller.signal,
          deadlineMs: Math.min(tool.deadlineMs, settingsService.get().budgets.toolDeadlineMs) });
        if (result.status === 'permission_required') continue; // the request now exists; wait on it
        // A native run pauses here until the user resumes it. A hosted agent keeps running, so the
        // user's takeover withdraws the consent instead: the next screen action asks them again.
        if (result.userInterrupted) permissions.revokeScreen(workspaceId, runId);
        const value = JSON.parse(result.output);
        /** @type {Array<{ type: string, text?: string, mimeType?: string, data?: string }>} */
        const content = [{ type: 'text', text: result.output }];
        for (const image of readResultImages(storage, run.sessionId, result.images ?? [])) content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
        return { content, structuredContent: value, isError: result.status !== 'ok' };
      }
    } finally {
      conn.closeHooks.delete(cancel);
      active.controller.signal.removeEventListener('abort', cancel);
      unlock();
      if (pending.get(runId) === turn) pending.delete(runId);
    }
  };
}
