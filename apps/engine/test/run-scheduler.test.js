import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { RunService } from '../src/runs/service.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-scheduler-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const gates = new Map(), started = [];
  let work = 0, sequence = 0;
  const runs = new RunService({ storage, log: { error() {}, warn() {} },
    lifetime: { workStarted() { work++; }, workFinished() { work--; } },
    executor: { execute: ctx => new Promise(resolve => {
      started.push(ctx.run.id);
      ctx.transition('model');
      gates.set(ctx.run.id, () => resolve({ outcome: 'completed' }));
      ctx.signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true });
    }) },
  });
  return { root, storage, project, workspace, runs, started,
    session: (workspaceId = workspace.id) => storage.createSession({ projectId: project.id, workspaceId, title: 'chat' }),
    start: session => runs.start({ sessionId: session.id, requestId: `request-${sequence++}`, prompt: 'test' }).run,
    state: run => storage.getRun(run.id).state,
    finish: run => gates.get(run.id)(),
    work: () => work,
    async close() { await runs.stopAll(); storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('independent chats run together in the same or nested folder beyond the old two-run limit', async () => {
  const f = fixture();
  try {
    const nested = path.join(f.root, 'nested'); mkdirSync(nested);
    const child = f.storage.ensureDirectWorkspace(f.project.id, nested);
    const sessions = [f.session(), f.session(), f.session(), f.session(child.id)];
    const active = sessions.map(f.start);
    await Bun.sleep(0);
    expect(active.map(f.state)).toEqual(['model', 'model', 'model', 'model']);
    expect(f.runs.activeCount).toBe(4);
    expect(f.runs.queuedCount).toBe(0);
    active.forEach(f.finish);
    await Bun.sleep(0);
    expect(active.map(f.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(f.work()).toBe(0);
  } finally { await f.close(); }
});

test('a chat preserves turn order while queued follow-ups do not block another chat', async () => {
  const f = fixture();
  try {
    const chat = f.session();
    const first = f.start(chat), second = f.start(chat), third = f.start(chat);
    const other = f.start(f.session());
    await Bun.sleep(0);
    expect([first, second, third, other].map(f.state)).toEqual(['model', 'queued', 'queued', 'model']);
    f.finish(first); await Bun.sleep(0);
    expect([first, second, third, other].map(f.state)).toEqual(['completed', 'model', 'queued', 'model']);
    f.finish(second); await Bun.sleep(0);
    expect(f.state(third)).toBe('model');
    expect(f.started).toEqual([first.id, other.id, second.id, third.id]);
  } finally { await f.close(); }
});

test('send now and cancellation affect only their own chat, even in a shared folder', async () => {
  const f = fixture();
  try {
    const chat = f.session();
    const first = f.start(chat), next = f.start(chat), urgent = f.start(chat);
    const other = f.start(f.session());
    await Bun.sleep(0);
    f.runs.sendNow({ runId: urgent.id }); await Bun.sleep(0);
    expect([first, next, urgent, other].map(f.state)).toEqual(['cancelled', 'queued', 'model', 'model']);
    f.runs.cancel({ runId: urgent.id }); await Bun.sleep(0);
    expect(f.state(next)).toBe('model');
    expect(f.state(other)).toBe('model');
  } finally { await f.close(); }
});
