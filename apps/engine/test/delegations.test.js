import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { RunService } from '../src/runs/service.js';
import { SettingsService } from '../src/settings.js';
import { createDelegationService, delegationInstructions } from '../src/delegation/index.js';
import { REPLY_MARGIN_MS, delegationBridge } from '../src/delegation/mcp.js';
import { delegationTools } from '../src/tools/delegation.js';

/**
 * `settings` is a settings patch applied before the service starts. `holdChild` keeps the child working until it is
 * stopped, in the run state it names (true: model); `childOutcome` is how a child that is not held ends.
 * @param {{ holdChild?: boolean | string, childOutcome?: string, settings?: any }} [options]
 */
function fixture({ holdChild = false, childOutcome = 'completed', settings: patch = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-delegations-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Parent' });
  let available = true;
  const executions = [];
  const runs = new RunService({ storage, log: { error() {}, warn() {} }, lifetime: { workStarted() {}, workFinished() {} },
    executor: { async execute(ctx) {
      if (ctx.run.prompt === 'fail with text') { // a later run of a child's conversation that says something, then fails
        const message = ctx.startMessage('assistant', 'text'); ctx.appendText(message, 'Half an answer'); ctx.finishMessage(message, 'complete');
        return { outcome: 'failed', failure: 'it broke' };
      }
      if (ctx.run.prompt === 'pause') return { outcome: 'paused' }; // a later run that paused for the person
      if (ctx.run.prompt === 'ask') { // a later run that asks the person and waits
        ctx.transition('awaiting_permission');
        await new Promise(resolve => { if (ctx.signal.aborted) resolve(null); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
        return { outcome: 'cancelled' };
      }
      if (!ctx.run.execution?.pinned || holdChild) {
        ctx.transition(ctx.run.execution?.pinned && typeof holdChild === 'string' ? holdChild : 'model');
        await new Promise(resolve => { if (ctx.signal.aborted) resolve(null); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
        return { outcome: 'cancelled' };
      }
      executions.push(ctx.run.execution);
      const message = ctx.startMessage('assistant', 'text'); ctx.appendText(message, 'Reviewed by the selected model.'); ctx.finishMessage(message, 'complete');
      return { outcome: childOutcome };
    } },
  });
  const catalog = { list: () => [{ id: 'codex', displayName: 'Codex', available, supportsModel: true, transport: 'codex-app-server' }] };
  const agentModels = { list: async () => ({ models: [{ id: 'model-v1', displayName: 'Model V1', efforts: ['high'] }] }) };
  const providerFactory = { presets: async () => ({ presets: [] }) };
  // What each child conversation's process is doing, as the hosted links report it; no entry is no live process. The
  // conversations whose background work was asked to stop are in `stopped`.
  const links = { activities: new Map(), stopped: [], get(id) {
    const a = this.activities.get(id);
    return a ? { activity: a, working: a.state !== 'idle', stopBackground: async () => { this.stopped.push(id); return { requested: 0, stopped: 0, escalated: false }; } } : null;
  } };
  const settings = new SettingsService(storage, { env: {} });
  if (patch) settings.update(patch);
  const log = { warn() {}, error() {}, info() {} };
  const service = createDelegationService({ storage, runs, catalog, agentModels, providerFactory, links, settings, log });
  const parent = runs.start({ sessionId: session.id, requestId: 'parent', prompt: 'Review this' }).run;
  return { storage, session, runs, service, parent, executions, catalog, agentModels, providerFactory, links, settings, log,
    /** Resolves once the run has ended, at once when it already has. */
    settled(runId) {
      return new Promise(resolve => {
        const done = run => { if (run.id === runId) { runs.settled.removeListener('run', done); resolve(run); } };
        runs.settled.on('run', done);
        const run = storage.getRun(runId);
        if (['completed', 'failed', 'cancelled', 'interrupted', 'paused'].includes(run.state)) done(run);
      });
    },
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
const activity = state => ({ state, tasks: [], truncated: false, updatedAt: new Date().toISOString() });

test('a child whose process still has background work is not done, and its output is partial', async () => {
  const f = fixture();
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { modelAlias: 'm1', prompt: 'model', title: 'Child', requestId: 'r1' });
    await f.settled(delegation.runId);
    f.links.activities.set(delegation.sessionId, activity('background'));
    const working = await f.service.status(f.parent.id, { delegationId: delegation.id });
    expect(working.delegation).toMatchObject({ state: 'completed', activity: 'background', done: false, partial: true });
    const waiting = f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 5000 });
    f.links.activities.set(delegation.sessionId, activity('idle'));
    f.storage.appendEvent({ sessionId: delegation.sessionId, type: 'session.activity', payload: f.links.activities.get(delegation.sessionId) });
    const { delegation: done } = await waiting;
    expect(done).toMatchObject({ done: true, partial: false, wakeReason: 'done' });
    // A tool display cut short still carries why the wait ended; the answer comes last.
    const keys = Object.keys(done);
    expect(keys[keys.indexOf('state') + 1]).toBe('wakeReason');
    expect(keys.slice(-2)).toEqual(['output', 'truncated']);
  } finally { await f.close(); }
});

test('waitMs is capped by the delegation.maxWaitMs setting', async () => {
  const f = fixture({ settings: { delegation: { maxWaitMs: 1000 } } });
  try {
    await f.select();
    expect(f.settings.get().delegation.maxWaitMs).toBe(1000);
    const { delegation } = await f.service.start(f.parent.id, { modelAlias: 'm1', prompt: 'model', title: 'Child', requestId: 'r2' });
    await f.settled(delegation.runId); // its answer is in before the wait begins, so only the cap can end it
    f.links.activities.set(delegation.sessionId, activity('background'));
    const started = Date.now();
    const { delegation: waited } = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(waited.wakeReason).toBe('timeout');
  } finally { await f.close(); }
});

test('a status read that does not wait says no wake reason', async () => {
  const f = fixture();
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { modelAlias: 'm1', prompt: 'model', title: 'Child', requestId: 'r11' });
    await f.settled(delegation.runId);
    const result = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 0 });
    expect(result.delegation).not.toHaveProperty('wakeReason');
  } finally { await f.close(); }
});

test('a wait ends when the child asks for permission, when the waiting tool call is stopped, and when the parent is', async () => {
  const f = fixture();
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r3' });
    await f.settled(delegation.runId);
    f.links.activities.set(delegation.sessionId, activity('working'));
    const waiting = f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 60_000 });
    f.storage.appendEvent({ sessionId: delegation.sessionId, runId: delegation.runId, type: 'permission.requested',
      payload: { permissionId: 'perm-1', runId: delegation.runId, workspaceId: 'ws', tool: 'Bash', summary: 'Bash ls', cwd: '.', isolation: 'none', revision: 1 } });
    expect((await waiting).delegation).toMatchObject({ activity: 'working', done: false, wakeReason: 'asking' });
    const stop = new AbortController();
    const stopped = f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 60_000 }, stop.signal);
    stop.abort();
    expect((await stopped).delegation).toMatchObject({ done: false, wakeReason: 'stopped' });
    const orphaned = f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 60_000 });
    f.runs.cancel({ runId: f.parent.id });
    expect((await orphaned).delegation).toMatchObject({ done: false, wakeReason: 'parent_stopped' });
  } finally { await f.close(); }
});

test('a wait begun while the child already waits on the person returns at once with that state', async () => {
  const f = fixture({ holdChild: 'awaiting_permission' });
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r6' });
    for (let tries = 0; f.storage.getRun(delegation.runId).state !== 'awaiting_permission'; tries++) { if (tries > 200) throw new Error('the child never asked'); await Bun.sleep(5); }
    const started = Date.now();
    const { delegation: asking } = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(asking).toMatchObject({ state: 'awaiting_permission', done: false });
  } finally { await f.close(); }
});

test('a paused child is not done, and a wait on it returns at once', async () => {
  const f = fixture({ childOutcome: 'paused' });
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r7' });
    await f.settled(delegation.runId);
    const started = Date.now();
    const { delegation: paused } = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(paused).toMatchObject({ state: 'paused', done: false });
  } finally { await f.close(); }
});

test('a later run of the child that paused for the person ends a wait on the delegation at once', async () => {
  const f = fixture();
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r9' });
    await f.settled(delegation.runId);
    const { run: later } = f.runs.start({ sessionId: delegation.sessionId, requestId: 'again', prompt: 'pause' });
    expect((await f.settled(later.id)).state).toBe('paused');
    const started = Date.now();
    const { delegation: seen } = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toMatchObject({ state: 'completed', done: false, wakeReason: 'asking' });
  } finally { await f.close(); }
});

test('a wait begun while a later run of the child waits on permission returns at once', async () => {
  const f = fixture();
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r10' });
    await f.settled(delegation.runId);
    const { run: later } = f.runs.start({ sessionId: delegation.sessionId, requestId: 'again', prompt: 'ask' });
    while (f.storage.getRun(later.id).state !== 'awaiting_permission') await Bun.sleep(10);
    const started = Date.now();
    const { delegation: seen } = await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toMatchObject({ state: 'completed', done: false });
  } finally { await f.close(); }
});

test("a child's answer is the last text of its newest completed run, not of a later run that failed", async () => {
  const f = fixture();
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r8' });
    await f.settled(delegation.runId);
    const { run: failed } = f.runs.start({ sessionId: delegation.sessionId, requestId: 'again', prompt: 'fail with text' });
    expect((await f.settled(failed.id)).state).toBe('failed');
    expect((await f.service.status(f.parent.id, { delegationId: delegation.id })).delegation.output).toBe('Reviewed by the selected model.');
  } finally { await f.close(); }
});

test('the delegation_status tool tells a parent to open a child that waits on the person', () => {
  const status = delegationTools.find(tool => tool.name === 'delegation_status');
  expect(status.description).toContain('If `activity` is working or background, the child is still working; if the child is awaiting_permission or paused, open the child task for user action; do not report `output` as final while `partial` is true. `wakeReason` says why a wait ended: done, answer, asking, parent_stopped, stopped (the call itself), or timeout.');
});

test('a wait begun while the child runs ends when the child is cancelled or fails without text', async () => {
  const f = fixture({ holdChild: true });
  try {
    await f.select();
    const { delegation } = await f.service.start(f.parent.id, { ...request, requestId: 'r4' });
    const started = Date.now();
    const waiting = f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 4000 });
    await Bun.sleep(100);
    f.service.cancel(f.parent.id, delegation.id);
    const { delegation: ended } = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ended).toMatchObject({ state: 'cancelled', done: true, output: '' });
  } finally { await f.close(); }
});

test('the hosted bridge waits for delegation_status as long as the tool may take', async () => {
  const calls = [];
  const client = { call: async (...args) => { calls.push(args); return { delegation: {} }; } };
  await delegationBridge.call(client, 'ws', { name: 'delegation_status', arguments: { delegationId: 'del-1', waitMs: 600_000 } });
  const status = delegationTools.find(tool => tool.name === 'delegation_status');
  expect(calls[0][2].timeoutMs).toBe(status.deadlineMs + REPLY_MARGIN_MS);
  expect(REPLY_MARGIN_MS).toBeGreaterThan(0);
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
