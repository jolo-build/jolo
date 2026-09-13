import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { createBoard } from '../src/board/index.js';

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-board-attention-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  cleanups.push(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const board = createBoard({ storage, env: { git: null, path: '' }, log: null });
  const chat = () => storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Chat' });
  let sequence = 0;
  const run = (session, state) => {
    const next = storage.insertRun({ sessionId: session.id, requestId: `prompt-${++sequence}`, prompt: 'Continue' });
    // Keep chronology deterministic even when inserts happen in the same millisecond.
    storage.db.query('UPDATE runs SET created_at = ?1 WHERE id = ?2').run(new Date(sequence * 1000).toISOString(), next.id);
    storage.updateRunState(next.id, state);
    return next;
  };
  const row = async () => (await board.list()).projects.find(row => row.workspaceId === workspace.id);
  return { storage, board, chat, run, row };
}

for (const problem of ['paused', 'failed', 'interrupted']) {
  test(`a new prompt replaces the ${problem} alert in the chat and folder`, async () => {
    const { storage, board, chat, run, row } = fixture();
    const session = chat();
    const previous = run(session, problem);
    expect(await row()).toMatchObject({ attention: 'needs_you', run: { id: previous.id } });

    const next = run(session, 'queued');
    for (const state of ['queued', 'preparing', 'model', 'tools', 'completed']) {
      storage.updateRunState(next.id, state);
      const folder = await row();
      const task = board.tasks().tasks.find(task => task.sessionId === session.id);
      expect(folder.run.id).toBe(next.id);
      expect(task.run.id).toBe(next.id);
      expect(folder.attention).not.toBe('needs_you');
      expect(task.attention).toBe(folder.attention);
    }
    expect(storage.getRun(previous.id).state).toBe(problem);
    storage.updateRunState(next.id, 'failed');
    expect(await row()).toMatchObject({ attention: 'needs_you', run: { id: next.id } });
  });
}

test('a queued follow-up keeps its live approval visible until the active turn settles', async () => {
  const { storage, board, chat, run, row } = fixture();
  const session = chat();
  const waiting = run(session, 'awaiting_permission');
  const next = run(session, 'queued');
  expect(await row()).toMatchObject({ attention: 'needs_you', run: { id: waiting.id } });
  expect(board.tasks().tasks[0].run.id).toBe(waiting.id);
  storage.updateRunState(waiting.id, 'paused');
  storage.updateRunState(next.id, 'model');
  expect(await row()).toMatchObject({ attention: 'running', run: { id: next.id } });
});

test('another chat waiting for the user keeps the folder alert', async () => {
  const { chat, run, row } = fixture();
  const waiting = run(chat(), 'paused');
  run(chat(), 'model');
  expect(await row()).toMatchObject({ attention: 'needs_you', working: true, run: { id: waiting.id } });
});
