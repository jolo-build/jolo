import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardTaskSchema } from '@jolo/protocol';
import { Storage } from '../src/storage/index.js';
import { createBoard } from '../src/board/index.js';

test('task identity follows its displayed run and never exposes provider configuration', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-task-identity-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  try {
    const project = storage.upsertProject({ identity: root, rootPath: root });
    const workspace = storage.insertWorkspace({ projectId: project.id, mode: 'worktree', path: root, branch: 'codex/parser' });
    const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Fix parser', agentId: 'claude' });
    const board = createBoard({ storage, env: { git: null, path: '' }, log: null });
    const task = () => BoardTaskSchema.parse(board.tasks().tasks[0]);
    expect(task().answerer).toEqual({ id: 'claude', displayName: null, model: null });
    const active = storage.insertRun({ sessionId: session.id, requestId: 'codex', prompt: 'review', execution: { agentId: 'codex', model: 'gpt-6-astra' } });
    storage.updateRunState(active.id, 'awaiting_permission');
    const queued = storage.insertRun({ sessionId: session.id, requestId: 'next', prompt: 'later', execution: { agentId: 'jolo', model: 'next-model' } });
    expect(task().run.id).toBe(active.id);
    expect(task().answerer).toEqual({ id: 'codex', displayName: null, model: 'gpt-6-astra' });
    expect(task()).toMatchObject({ branch: 'codex/parser', mode: 'worktree' });

    storage.updateRunState(active.id, 'completed');
    storage.updateRunState(queued.id, 'model');
    // A native turn's captured model wins over later picker changes and stale handoff data.
    storage.setRunProviderConfig(queued.id, { pending: true, ref: { model: 'captured-model' }, endpoint: { headers: { private: 'never-in-sidebar' } } });
    storage.setSessionAgentState(session.id, { _jolo: { lastRunId: active.id, lastAnswerer: { id: 'codex', displayName: 'Codex', model: 'gpt-6-astra' } } });
    storage.setSessionModel(session.id, { preset: 'openai', model: 'changed-model' });
    expect(task().answerer).toEqual({ id: 'jolo', displayName: null, model: 'captured-model' });
    // No explicit model override: use the resolved provider model, not the session picker.
    storage.db.query('UPDATE runs SET execution = NULL WHERE id = ?1').run(queued.id);
    expect(task().answerer.model).toBe('captured-model');
    expect(JSON.stringify(board.tasks())).not.toContain('never-in-sidebar');

    storage.updateRunState(queued.id, 'completed');
    storage.setSessionAgentState(session.id, { _jolo: { lastRunId: queued.id, lastAnswerer: { id: 'jolo', displayName: 'Jolo', model: 'resolved-model' } } });
    // Ensure the latest completed turn is deterministic even in this sub-millisecond fixture.
    storage.db.query("UPDATE runs SET created_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1").run(queued.id);
    expect(task().answerer).toEqual({ id: 'jolo', displayName: 'Jolo', model: 'resolved-model' });
    storage.setSessionAgent(session.id, 'claude');
    expect(task().answerer.id).toBe('jolo');
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});
