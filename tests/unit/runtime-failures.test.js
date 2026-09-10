import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from '../../apps/engine/src/storage/index.js';
import { RunService } from '../../apps/engine/src/runs/service.js';
import { PermissionService } from '../../apps/engine/src/permissions/service.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-failure-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  return { root, storage, close() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('caught savepoint rollback discards events and scheduling, including reused sequence numbers', () => {
  const f = fixture();
  try {
    const seen = [], callbacks = [];
    f.storage.events.on('event', event => seen.push(event));
    f.storage.transaction(() => {
      f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'first', scope: 'inspect' } });
      try { f.storage.transaction(() => {
        f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'rolled-back', scope: 'inspect' } });
        f.storage.afterCommit(() => callbacks.push('rolled-back'));
        throw new Error('rollback');
      }); } catch {}
      f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'last', scope: 'inspect' } });
      f.storage.afterCommit(() => callbacks.push('committed'));
      expect(seen).toHaveLength(0);
    });
    expect(seen.map(e => e.payload.grantId)).toEqual(['first', 'last']);
    expect(seen.map(e => e.eventSeq)).toEqual(['1', '2']);
    expect(callbacks).toEqual(['committed']);
  } finally { f.close(); }
});

test('events committed by a listener stay in order for every other listener', () => {
  const f = fixture();
  try {
    const seen = [];
    f.storage.events.on('event', event => { if (event.payload.grantId === 'first') f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'reentrant', scope: 'inspect' } }); });
    f.storage.events.on('event', event => seen.push(event.eventSeq));
    f.storage.transaction(() => {
      f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'first', scope: 'inspect' } });
      f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'second', scope: 'inspect' } });
    });
    expect(seen).toEqual(['1', '2', '3']);
  } finally { f.close(); }
});

function service(f, execute, options = {}) {
  const project = f.storage.upsertProject({ identity: f.root, rootPath: f.root });
  const workspace = f.storage.ensureDirectWorkspace(project.id, f.root);
  const session = f.storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'test' });
  let work = 0;
  const runs = new RunService({ storage: f.storage, executor: { execute }, log: { error() {}, warn() {} }, lifetime: { workStarted() { work++; }, workFinished() { work--; } }, ...options });
  const start = () => runs.start({ sessionId: session.id, requestId: String(Math.random()), prompt: 'test' }).run;
  return { runs, start, work: () => work };
}

test('artifact commit failure closes writers, settles failed run, and releases queue', async () => {
  const f = fixture();
  try {
    const s = service(f, async ctx => {
      const id = ctx.startMessage('assistant');
      ctx.appendText(id, 'not yet committed');
      ctx.finishMessage(id, 'complete');
      return { outcome: 'completed' };
    });
    const commit = f.storage.commitArtifactBytes.bind(f.storage);
    let fail = true;
    f.storage.commitArtifactBytes = (...args) => { if (fail) { fail = false; throw new Error('injected disk failure'); } return commit(...args); };
    const settled = [];
    s.runs.settled.on('run', run => settled.push(run));
    const first = s.start(), next = s.start();
    for (let n = 0; n < 100 && s.work(); n++) await Bun.sleep(10);
    expect(f.storage.getRun(first.id).state).toBe('failed');
    expect(f.storage.getRun(next.id).state).toBe('completed');
    expect(settled).toHaveLength(2);
    expect(f.storage.artifacts.writers.size).toBe(0);
    expect(f.storage.listStreamingMessages()).toHaveLength(0);
    expect(s.work()).toBe(0);
  } finally { f.close(); }
});

test('shutdown has a deadline even when an executor ignores cancellation', async () => {
  const f = fixture();
  try {
    const s = service(f, () => new Promise(() => {}), { shutdownMs: 20 });
    const run = s.start();
    await Bun.sleep(10);
    const before = Date.now();
    await s.runs.stopAll();
    expect(Date.now() - before).toBeLessThan(500);
    expect(f.storage.getRun(run.id).state).toBe('interrupted');
  } finally { f.close(); }
});

test('invalid event payloads cannot be committed into the replay feed', () => {
  const f = fixture();
  try {
    expect(() => f.storage.appendEvent({ type: 'grant.created', payload: {} })).toThrow();
    expect(f.storage.maxSeq()).toBe('0');
    expect(f.storage.listEvents({ after: '0' })).toHaveLength(0);
  } finally { f.close(); }
});

test('single-use approvals bind the tool and cannot substitute for run or project grants', () => {
  const f = fixture();
  try {
    const permissions = new PermissionService({ storage: f.storage });
    const constraints = { workspaceId: 'workspace', runId: 'run', argumentDigest: 'same-arguments', toolName: 'claude:command', once: true };
    const once = f.storage.insertGrant({ scope: 'execute', constraints });
    const request = { toolClass: 'process', ...constraints };
    expect(permissions.authorize(request).id).toBe(once.id);
    expect(() => permissions.authorize({ ...request, toolName: 'grok:command' })).toThrow('requires user approval');
    expect(() => permissions.authorize({ ...request, toolName: 'claude:other' })).toThrow('requires user approval');
    const run = permissions.grantScope('execute', { workspaceId: 'workspace', runId: 'run' });
    expect(run.created).toBe(true);
    expect(run.grant.constraints).toEqual({ workspaceId: 'workspace', runId: 'run' });
    const project = permissions.grantScope('execute', { workspaceId: 'workspace' });
    expect(project.created).toBe(true);
    expect(project.grant.constraints).toEqual({ workspaceId: 'workspace' });
    expect(permissions.grantScope('execute', { workspaceId: 'workspace' }).created).toBe(false);
  } finally { f.close(); }
});
