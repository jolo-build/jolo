import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from '../../apps/engine/src/storage/index.js';

test('folder activity follows executing tasks independently of its attention task', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-activity-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  try {
    const project = storage.upsertProject({ identity: root, rootPath: root });
    const workspace = storage.ensureDirectWorkspace(project.id, root);
    const first = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Waiting' });
    const second = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Working' });
    const waiting = storage.insertRun({ sessionId: first.id, requestId: 'wait', prompt: 'wait' });
    storage.updateRunState(waiting.id, 'awaiting_permission');
    const active = storage.insertRun({ sessionId: second.id, requestId: 'active', prompt: 'work' });
    expect(storage.workspaceHasWorkingRuns(workspace.id)).toBe(false);
    for (const state of ['preparing', 'model', 'tools', 'cancelling']) {
      storage.updateRunState(active.id, state);
      expect(storage.workspaceHasWorkingRuns(workspace.id)).toBe(true);
      expect(storage.boardRunForWorkspace(workspace.id).run.id).toBe(waiting.id);
    }
    storage.db.query("UPDATE sessions SET state = 'archived' WHERE id = ?1").run(second.id);
    expect(storage.workspaceHasWorkingRuns(workspace.id)).toBe(false);
    storage.db.query("UPDATE sessions SET state = 'open' WHERE id = ?1").run(second.id);
    for (const state of ['completed', 'cancelled', 'failed', 'paused', 'interrupted']) {
      storage.updateRunState(active.id, state);
      expect(storage.workspaceHasWorkingRuns(workspace.id)).toBe(false);
    }
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});
