import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { RunService } from '../src/runs/service.js';
import { createDelegationService, delegationInstructions } from '../src/delegation/index.js';

function fixture({ holdChild = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-delegations-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Parent' });
  let available = true;
  const executions = [];
  const runs = new RunService({ storage, log: { error() {}, warn() {} }, lifetime: { workStarted() {}, workFinished() {} },
    executor: { async execute(ctx) {
      if (!ctx.run.execution?.pinned || holdChild) {
        ctx.transition('model');
        await new Promise(resolve => { if (ctx.signal.aborted) resolve(null); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
        return { outcome: 'cancelled' };
      }
      executions.push(ctx.run.execution);
      const message = ctx.startMessage('assistant', 'text'); ctx.appendText(message, 'Reviewed by the selected model.'); ctx.finishMessage(message, 'complete');
      return { outcome: 'completed' };
    } },
  });
  const catalog = { list: () => [{ id: 'codex', displayName: 'Codex', available, supportsModel: true, transport: 'codex-app-server' }] };
  const agentModels = { list: async () => ({ models: [{ id: 'model-v1', displayName: 'Model V1', efforts: ['high'] }] }) };
  const providerFactory = { presets: async () => ({ presets: [] }) };
  const service = createDelegationService({ storage, runs, catalog, agentModels, providerFactory });
  const parent = runs.start({ sessionId: session.id, requestId: 'parent', prompt: 'Review this' }).run;
  return { storage, session, runs, service, parent, executions, catalog, agentModels, providerFactory,
    unavailable() { available = false; },
    async select() { const choices = await service.prepare('Review with ^agent:codex/model-v1~high'); storage.transaction(() => service.register(session.id, choices)); },
    async close() { service.close(); await runs.stopAll(); storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const request = { modelAlias: 'm1', prompt: 'Review the diff and explain findings', title: 'Review', requestId: 'review-1' };

test('a selected model persists and runs a separate child with exact model and effort, returning its result', async () => {
  const f = fixture();
  try {
    await f.select(); await f.select();
    expect(f.service.listModels(f.parent.id).models).toHaveLength(1);
    expect(delegationInstructions(f.storage, f.parent)).toContain('m1: Model V1');
    const { delegation } = await f.service.start(f.parent.id, request);
    expect(delegation.sessionId).not.toBe(f.session.id);
    const result = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 1000 });
    expect(result.delegation.failure).toBeNull();
    expect(result.delegation.state).toBe('completed');
    expect(result.delegation.output).toBe('Reviewed by the selected model.');
    expect(f.executions).toEqual([{ agentId: 'codex', preset: null, model: 'model-v1', effort: 'high', pinned: true }]);
    expect((await f.service.start(f.parent.id, request)).delegation.id).toBe(delegation.id);
    f.service.close();
    const reopened = createDelegationService(f);
    expect(reopened.listModels(f.parent.id).models[0].selector).toBe('agent:codex/model-v1~high');
    reopened.close();
  } finally { await f.close(); }
});
test('unknown aliases and unavailable selected models fail without starting a substitute', async () => {
  const f = fixture();
  try {
    await expect(f.service.start(f.parent.id, request)).rejects.toThrow('Choose an alias');
    await expect(f.service.prepare('Use ^agent:codex/nonexistent')).rejects.toThrow('unavailable');
    await f.select(); f.unavailable();
    await expect(f.service.start(f.parent.id, request)).rejects.toThrow('unavailable');
    expect(f.service.list(f.session.id).delegations).toEqual([]);
  } finally { await f.close(); }
});
test('children cannot delegate again and another conversation cannot read or cancel them', async () => {
  const f = fixture({ holdChild: true });
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, request);
    await expect(f.service.start(delegation.runId, request)).rejects.toThrow('cannot create more');
    await expect(f.service.status(delegation.runId, { delegationId: delegation.id })).rejects.toThrow('Unknown delegated task');
    expect(() => f.service.cancel(delegation.runId, delegation.id)).toThrow('Unknown delegated task');
    f.runs.cancel({ runId: f.parent.id });
    await Bun.sleep(10);
    expect(f.storage.getRun(delegation.runId).state).toBe('cancelled');
  } finally { await f.close(); }
});
test('concurrent retries admit one child and active child count is bounded', async () => {
  const f = fixture({ holdChild: true });
  try {
    await f.select();
    const results = await Promise.all([f.service.start(f.parent.id, request), f.service.start(f.parent.id, request)]);
    expect(results[0].delegation.id).toBe(results[1].delegation.id);
    for (let i = 2; i <= 4; i++) await f.service.start(f.parent.id, { ...request, requestId: `review-${i}` });
    await expect(f.service.start(f.parent.id, { ...request, requestId: 'review-5' })).rejects.toThrow('4 active');
  } finally { await f.close(); }
});
