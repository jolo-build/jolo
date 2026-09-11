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

test('first workspace prompt assigns a title, retries and later turns preserve it', async () => {
  const f = fixture();
  try {
    const session = f.storage.createSession({ projectId: f.project.id, workspaceId: f.workspace.id, title: '' });
    const request = { sessionId: session.id, requestId: 'title-first', prompt: '  Fix\n the browser tabs  ', expectedSessionRevision: session.revision };
    f.runs.start(request);
    expect(f.storage.getSession(session.id).title).toBe('Fix the browser tabs');
    expect(f.runs.start(request).deduplicated).toBe(true);
    f.start(session);
    expect(f.storage.getSession(session.id).title).toBe('Fix the browser tabs');
    const named = f.session(); f.start(named);
    expect(f.storage.getSession(named.id).title).toBe('chat');
    const stale = f.storage.createSession({ projectId: f.project.id, workspaceId: f.workspace.id, title: '' });
    expect(() => f.runs.start({ ...request, sessionId: stale.id, expectedSessionRevision: 999 })).toThrow('revision');
    expect(f.storage.getSession(stale.id).title).toBe('');
  } finally { await f.close(); }
});

test('startup recovers old unnamed tasks from their first prompt without reordering activity', async () => {
  const f = fixture();
  try {
    const session = f.storage.createSession({ projectId: f.project.id, workspaceId: f.workspace.id, title: '' });
    f.storage.insertRun({ sessionId: session.id, requestId: 'old-first', prompt: 'Original task' });
    f.storage.insertRun({ sessionId: session.id, requestId: 'old-next', prompt: 'Follow up' });
    const before = f.storage.getSession(session.id);
    f.storage.close();
    // Release cached SQLite statements before opening a second connection in-process.
    Bun.gc(true);
    const reopened = new Storage({ databasePath: path.join(f.root, 'db'), artifactsDir: path.join(f.root, 'artifacts'), bootId: 'restart' });
    try {
      expect(reopened.getSession(session.id).title).toBe('Original task');
      expect(reopened.getSession(session.id).updatedAt).toBe(before.updatedAt);
      const revision = reopened.getSession(session.id).revision;
      reopened.repairUntitledSessions();
      expect(reopened.getSession(session.id).revision).toBe(revision);
    } finally { reopened.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
