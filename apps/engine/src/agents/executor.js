import { SELF_MENTION } from './mentions.js';
import { createClaudeStreamExecutor } from './claude-stream.js';
import { createCodexAppServerExecutor } from './codex-app-server.js';
import { createAcpExecutor } from './acp.js';
import { createAntigravityExecutor } from './antigravity-stream.js';
import { rememberConversation } from './handoff.js';

/** @typedef {{outcome: 'completed'|'failed'|'cancelled'|'paused', failure?: string, pauseReason?: 'permission'|'budget'|'user', detail?: string, permissionId?: string}} ExecutorResult */
/** @typedef {{name: string, execute(ctx: object, answerer?: object): Promise<ExecutorResult>}} Executor */

// All task-capable transports register their executor at this one boundary.
export const EXECUTOR_FACTORIES = Object.freeze({ 'claude-stream': createClaudeStreamExecutor, 'codex-app-server': createCodexAppServerExecutor, acp: createAcpExecutor, 'antigravity-stream': createAntigravityExecutor });

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
      rememberConversation(storage, ctx.run, answerer, result.outcome === 'completed', { carried: result.carried !== false, reached: result.reached === true });
      return result;
    },
  };
}

/**
 * Run one hosted turn under Jolo's budgets: active time, iterations, and optional tool deadlines.
 * @param {{ ctx: any, manifest: any, adapter: any, storage: any, budget: any, interactiveClients: () => number,
 *   revoke?: (runId: string) => void, tickMs?: number }} options `revoke` withdraws the guest credentials the
 * run was issued; an engine that hands out none passes nothing
 */
export async function executeHosted({ ctx, manifest, adapter, storage, budget, interactiveClients, revoke = () => {}, tickMs = 250 }) {
  const controller = new AbortController();
  const abort = () => controller.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', abort, { once: true });
  if (ctx.signal.aborted) abort();
  let activeMs = 0, previous = Date.now(), phase = null, iterations = 0, holdPermission = false;
  /** @type {Record<string, unknown> | null} */
  let pause = null;
  // Whether the run only waits on the user, from an adapter that can tell (null: the run's shown state says).
  let waitingOnUser = null;
  // Protocols expose different message types; count observable model phases,
  // never token deltas. Hidden vendor-internal calls remain vendor-owned.
  // A phase replayed from work the vendor already did by itself is shown but not counted again.
  const count = (state, { counted = true } = {}) => {
    if (!counted) { phase = 'replayed'; return; }
    if (state === 'model' && phase !== 'model' && ++iterations > budget.maxIterations) {
      exhausted('iteration budget reached'); controller.signal.throwIfAborted();
    }
    phase = state;
  };
  /** The question to pause on: the main thread's own, which it is blocked on, before one background work asked. */
  const pauseOn = runId => {
    const pending = storage.pendingPermissionsForRun(runId);
    return (pending.filter(permission => !permission.request?.grantRunId).at(-1) ?? pending.at(-1))?.id;
  };
  const tools = new Map();
  const stop = result => { if (!pause) { pause = result; controller.abort(); } };
  const exhausted = detail => stop({ outcome: 'paused', pauseReason: 'budget', detail });
  const monitor = setInterval(() => {
    const now = Date.now(), run = storage.getRun(ctx.run.id);
    const waiting = waitingOnUser ?? run?.state === 'awaiting_permission';
    if (!waiting) activeMs += now - previous;
    previous = now;
    // With nobody to ask, a run only waiting on the user pauses, unless what it waits on is background work's question
    // with the main thread idle (then it waits for a window, as the asker does). Work going on is never paused for it.
    if (run?.state === 'awaiting_permission' && waiting && interactiveClients() === 0 && !holdPermission) {
      stop({ outcome: 'paused', pauseReason: 'permission', permissionId: pauseOn(run.id) });
    } else if (activeMs >= budget.maxActiveMs) exhausted('active time budget reached');
    else if (budget.hostedToolDeadlineMs != null && [...tools.values()].some(start => activeMs - start >= budget.hostedToolDeadlineMs)) exhausted('hosted tool deadline reached');
  }, tickMs);
  try {
    const result = await adapter.execute({
      ...ctx, signal: controller.signal,
      transition(state, options) { count(state, options); return ctx.transition(state); },
      // A model phase while the run shows a question waiting on the user still counts against the iteration budget.
      countPhase(state, options) { count(state, options); },
      // Background work can ask while the main thread works on: only the adapter knows when nothing but the user is
      // awaited, which is when active time stops counting.
      waitingOnUser(flag) { waitingOnUser = flag; },
      toolStarted(id) { controller.signal.throwIfAborted(); tools.set(String(id), activeMs); },
      // A vendor can return to the model while a command (for example a dev server)
      // keeps running. It no longer blocks a tool response; the turn's active-time
      // budget and cancellation still apply to it.
      toolBackgrounded(id) { tools.delete(String(id)); },
      // A run that only answers a question background work is waiting on keeps waiting for a window instead of pausing.
      keepWaitingForPermission(hold = true) { holdPermission = hold; },
      toolFinished(id) { tools.delete(String(id)); },
    }, manifest);
    // Whether the turn reached the vendor's own thread holds whatever stopped it.
    const reached = result?.reached === true ? { reached: true } : {};
    return ctx.signal.aborted ? { outcome: 'cancelled', ...reached } : pause ? { ...pause, ...reached } : result;
  } catch (error) {
    if (ctx.signal.aborted) return { outcome: 'cancelled' };
    if (pause) return pause;
    throw error;
  } finally {
    clearInterval(monitor); ctx.signal.removeEventListener('abort', abort); revoke(ctx.run.id);
  }
}
