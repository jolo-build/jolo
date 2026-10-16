import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentEdits, recordAgentEdits } from '../src/agents/edit-records.js';
import { Storage } from '../src/storage/index.js';

const cleanup = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));

test('vendor diffs normalize without Git, preserving external paths and renames', () => {
  const edits = agentEdits('codex', { changes: [{ path: '/project/a.js', kind: { type: 'update', move_path: '/other/a.js' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] }, null, '/project');
  expect(edits[0]).toMatchObject({ path: 'a.js', newPath: '/other/a.js', op: 'rename' });
  expect(edits[0].diff).toContain('b//other/a.js');
  const acp = agentEdits('acp', { content: [{ type: 'diff', path: '/project/new.ts', oldText: null, newText: 'const a = 1;\n' }] }, null, '/project');
  expect(acp[0]).toMatchObject({ path: 'new.ts', op: 'create' });
  expect(acp[0].diff).toContain('+const a = 1;');
});

test('Claude uses acknowledged hunks and does not invent preimages or parse shell prose', () => {
  const input = { name: 'Edit', input: { file_path: '/project/a.js' } };
  const edits = agentEdits('claude', { structuredPatch: [{ oldStart: 35, oldLines: 1, newStart: 35, newLines: 1, lines: ['-old', '+new'] }] }, input, '/project');
  expect(edits[0].diff).toContain('@@ -35,1 +35,1 @@');
  expect(agentEdits('claude', {}, { name: 'Write', input: { file_path: 'a.js', content: 'not necessarily new' } }, '/project')[0].diff).toBe('');
  expect(agentEdits('claude', {}, { name: 'Bash', input: { command: 'echo Edit a.js' } }, '/project')).toEqual([]);
});

test('edit attribution and immutable references survive event pruning and reopening', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-edit-records-'));
  const options = { databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' };
  let storage = new Storage(options);
  cleanup.push(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const project = storage.upsertProject({ identity: 'no-git', rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const a = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'A' });
  const b = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'B' });
  const runA = storage.insertRun({ sessionId: a.id, requestId: 'a', prompt: 'edit' });
  const runB = storage.insertRun({ sessionId: b.id, requestId: 'b', prompt: 'edit same file' });
  const edits = agentEdits('codex', { changes: [{ path: 'same.js', diff: '@@ -1 +1 @@\n-old\n+new' }] }, null, root);
  recordAgentEdits({ storage, sessionId: a.id, runId: runA.id, tool: { invocationId: 'tool-a', messageId: 'message-a', name: 'edit' }, edits });
  const saved = storage.changeEventsForRun(runA.id);
  expect(saved[0].diffArtifactId).toBeString();
  expect(storage.changeEventsForRun(runB.id)).toEqual([]);
  storage.eventRepository.prune(0);
  storage.close(); Bun.gc(true); storage = new Storage(options);
  expect(storage.changeEventsForRun(runA.id)).toEqual(saved);
  expect(storage.changedPathsForRun(runA.id)).toEqual(['same.js']);
});
