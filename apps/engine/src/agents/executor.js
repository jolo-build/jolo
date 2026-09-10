import { SELF_MENTION } from './mentions.js';
import { createClaudeStreamExecutor } from './claude-stream.js';
import { createCodexAppServerExecutor } from './codex-app-server.js';
import { createAcpExecutor } from './acp.js';
import { rememberConversation } from './handoff.js';

/** @typedef {{outcome: 'completed'|'failed'|'cancelled'|'paused', failure?: string, pauseReason?: 'permission'|'budget'|'user', detail?: string, permissionId?: string}} ExecutorResult */
/** @typedef {{name: string, execute(ctx: object, answerer?: object): Promise<ExecutorResult>}} Executor */

// All task-capable transports register their executor at this one boundary.
export const EXECUTOR_FACTORIES = Object.freeze({ 'claude-stream': createClaudeStreamExecutor, 'codex-app-server': createCodexAppServerExecutor, acp: createAcpExecutor });

export function createExecutorRouter(deps) {
  const { storage, catalog, settings, native, interactiveClients, revoke } = deps;
  const hosted = Object.fromEntries(Object.entries(EXECUTOR_FACTORIES).map(([name, factory]) => [name, factory(deps)]));
  return {
    name: 'dispatch',
    async execute(ctx) {
      const guest = ctx.run.execution?.preset ? SELF_MENTION : ctx.run.execution?.agentId ?? null;
      const agentId = guest === SELF_MENTION ? null : guest ?? storage.getSession(ctx.run.sessionId)?.agentId;
      if (!agentId) {
        const result = await native.execute(ctx);
        const saved = storage.getRunProviderConfig?.(ctx.run.id);
        const answerer = { id: 'jolo', displayName: 'Jolo', model: saved?.model ?? saved?.ref?.model ?? settings.get().model?.model ?? null };
        rememberConversation(storage, ctx.run, answerer, result.outcome === 'completed');
        return result;
      }
      let manifest;
      try { manifest = catalog.get(agentId); }
      catch { return { outcome: 'failed', failure: `the agent ${agentId} that answers this task is no longer in the catalog` }; }
      const adapter = hosted[manifest.transport];
      if (!adapter) return { outcome: 'failed', failure: `${manifest.displayName} runs in a terminal and cannot answer a task` };
      const configured = catalog.config(manifest, { ...(ctx.run.execution?.model ? { model: ctx.run.execution.model } : {}) });
      const answerer = { id: manifest.id, displayName: manifest.displayName, model: configured.model ?? null };
      const result = await executeHosted({ ctx, manifest, adapter, storage, budget: settings.get().budgets, interactiveClients, revoke });
      rememberConversation(storage, ctx.run, answerer, result.outcome === 'completed');
      return result;
    },
  };
}

export async function executeHosted({ ctx, manifest, adapter, storage, budget, interactiveClients, revoke = () => {}, tickMs = 250 }) {
  const controller = new AbortController();
  const abort = () => controller.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', abort, { once: true });
  if (ctx.signal.aborted) abort();
  let activeMs = 0, previous = Date.now(), pause = null, phase = null, iterations = 0;
  const tools = new Map();
  const stop = result => { if (!pause) { pause = result; controller.abort(); } };
  const exhausted = detail => stop({ outcome: 'paused', pauseReason: 'budget', detail });
  const monitor = setInterval(() => {
    const now = Date.now(), run = storage.getRun(ctx.run.id);
    if (run?.state !== 'awaiting_permission') activeMs += now - previous;
    previous = now;
    if (run?.state === 'awaiting_permission' && interactiveClients() === 0) {
      stop({ outcome: 'paused', pauseReason: 'permission', permissionId: storage.pendingPermissionForRun(run.id)?.id });
    } else if (activeMs >= budget.maxActiveMs) exhausted('active time budget reached');
    else if ([...tools.values()].some(start => activeMs - start >= budget.toolDeadlineMs)) exhausted('hosted tool deadline reached');
  }, tickMs);
  try {
    const result = await adapter.execute({
      ...ctx, signal: controller.signal,
      transition(state) {
        // Protocols expose different message types; count observable model phases,
        // never token deltas. Hidden vendor-internal calls remain vendor-owned.
        if (state === 'model' && phase !== 'model' && ++iterations > budget.maxIterations) {
          exhausted('iteration budget reached'); controller.signal.throwIfAborted();
        }
        phase = state;
        return ctx.transition(state);
      },
      toolStarted(id) { controller.signal.throwIfAborted(); tools.set(String(id), activeMs); },
      // A vendor can return to the model while a command (for example a dev server)
      // keeps running. It no longer blocks a tool response; the turn's active-time
      // budget and cancellation still apply to it.
      toolBackgrounded(id) { tools.delete(String(id)); },
      toolFinished(id) { tools.delete(String(id)); },
    }, manifest);
    return ctx.signal.aborted ? { outcome: 'cancelled' } : pause ?? result;
  } catch (error) {
    if (ctx.signal.aborted) return { outcome: 'cancelled' };
    if (pause) return pause;
    throw error;
  } finally {
    clearInterval(monitor); ctx.signal.removeEventListener('abort', abort); revoke(ctx.run.id);
  }
}
