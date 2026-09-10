import { ProtocolError } from '@jolo/protocol';
import { newId } from '../storage/index.js';

/** Browser access uses the run in the credential, never a model-supplied run id. */
export function browserCallHandler({ storage, runs, dispatcher, settingsService }) {
  const pending = new Map();
  return async ({ workspaceId, name, arguments: args }, conn) => {
    const runId = conn.capability?.runId;
    const active = runs.active.get(runId);
    const run = runId && storage.getRun(runId);
    const session = run && storage.getSession(run.sessionId);
    if (!active || active.controller.signal.aborted || session?.workspaceId !== workspaceId || conn.capability.workspaceId !== workspaceId) throw new ProtocolError('permission_denied', 'browser tools require a live run credential for this workspace');
    if (!dispatcher.registry.get(name)?.browserOperation) throw new ProtocolError('invalid_params', 'unknown browser tool');
    if ((pending.get(runId) ?? 0) >= 4) throw new ProtocolError('limit_exceeded', 'browser is busy; wait for the current operations');
    const workspace = storage.getWorkspace(workspaceId);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    conn.closeHooks.add(cancel);
    active.controller.signal.addEventListener('abort', cancel, { once: true });
    pending.set(runId, (pending.get(runId) ?? 0) + 1);
    try {
      const result = await dispatcher.invoke({ run, workspace: { id: workspace.id, root: workspace.path }, call: { callId: newId('browser'), name, arguments: args }, signal: controller.signal,
        deadlineMs: Math.min(dispatcher.registry.get(name).deadlineMs, settingsService.get().budgets.toolDeadlineMs) });
      const value = JSON.parse(result.output);
      const content = [{ type: 'text', text: result.output }];
      if (name === 'browser_screenshot' && result.status === 'ok' && value.artifactId) {
        const artifact = storage.getArtifact(value.artifactId);
        if (artifact?.sessionId === run.sessionId && artifact.kind === 'screenshot' && artifact.committedBytes <= 1024 * 1024) {
          const { buffer } = storage.readArtifact(artifact, 0, artifact.committedBytes, artifact.committedBytes);
          content.push({ type: 'image', mimeType: 'image/png', data: buffer.toString('base64') });
        }
      }
      return { content, structuredContent: value, isError: result.status !== 'ok' };
    } finally {
      conn.closeHooks.delete(cancel);
      active.controller.signal.removeEventListener('abort', cancel);
      const count = pending.get(runId) - 1;
      if (count) pending.set(runId, count); else pending.delete(runId);
    }
  };
}
