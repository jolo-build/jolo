import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Storage } from '../src/storage/index.js';
import { recordActivity } from '../src/engine.js';
import { ENDED_SUMMARY, endedActivity } from '../src/agents/claude-link.js';

/** A real database in a temp dir with one conversation, and every durable event it emits. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-activity-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'chat', agentId: 'claude' });
  const events = [];
  storage.events.on('event', (event) => events.push(event));
  return { storage, session, events, close() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** A task as an activity carries it. */
const task = (taskId, status, fields = {}) => ({
  taskId, runId: `${taskId}-run`, toolUseId: null, description: `task ${taskId}`, subagentType: null, taskType: 'local_bash', workflowName: null, phase: null,
  backgrounded: true, status, startedAt: '2026-10-24T10:00:00.000Z', endedAt: status === 'running' ? null : '2026-10-24T10:01:00.000Z',
  usage: { totalTokens: null, toolUses: null, durationMs: null }, workflow: null, parentTaskId: null, spawnDepth: null, lastTool: null, progress: null, summary: null, outputFile: null, ...fields,
});
const payload = (tasks, state = 'background') => ({ state, tasks, truncated: false, updatedAt: '2026-10-24T10:02:00.000Z' });

test('a conversation\'s activity is kept in its own row: saved over, read back, and nothing for one that never had any', () => {
  const f = fixture();
  try {
    expect(f.storage.getSessionActivity(f.session.id)).toBeNull();
    f.storage.saveSessionActivity(f.session.id, payload([task('a', 'running')]));
    f.storage.saveSessionActivity(f.session.id, payload([task('a', 'completed'), task('b', 'running')]));
    expect(f.storage.getSessionActivity(f.session.id)).toEqual(payload([task('a', 'completed'), task('b', 'running')]));
  } finally { f.close(); }
});

test('clearing finished tasks rewrites the row without them and says how many went; no row clears nothing', () => {
  const f = fixture();
  try {
    expect(f.storage.clearFinishedActivity(f.session.id)).toBe(0);
    f.storage.saveSessionActivity(f.session.id, { ...payload([task('a', 'completed'), task('b', 'running'), task('c', 'failed'), task('d', 'stopped')]), truncated: true });
    expect(f.storage.clearFinishedActivity(f.session.id)).toBe(3);
    expect(f.storage.getSessionActivity(f.session.id)).toEqual(payload([task('b', 'running')])); // nothing older left out either
    expect(f.storage.clearFinishedActivity(f.session.id)).toBe(0);
  } finally { f.close(); }
});

test('what a process does is stored with its event for a change of state or tasks, and neither for progress alone', () => {
  const f = fixture();
  try {
    const previews = new EventEmitter();
    const seen = [];
    previews.on('activity', (value) => seen.push(value));
    const activity = { state: 'background', tasks: [task('a', 'running')], updatedAt: '2026-10-24T10:02:00.000Z' };
    recordActivity(f.storage, previews, f.session.id, activity, 'progress');
    expect(f.storage.getSessionActivity(f.session.id)).toBeNull();
    expect(f.events).toEqual([]);
    expect(seen).toHaveLength(1);
    recordActivity(f.storage, previews, f.session.id, activity, 'state');
    expect(f.storage.getSessionActivity(f.session.id)).toEqual({ ...activity, truncated: false });
    expect(f.events.map((event) => [event.type, event.payload.state])).toEqual([['session.activity', 'background']]);
    recordActivity(f.storage, previews, f.session.id, { ...activity, state: 'idle', tasks: [task('a', 'completed')] }, 'tasks');
    expect(f.storage.getSessionActivity(f.session.id).tasks.map((item) => item.status)).toEqual(['completed']);
    // A conversation deleted meanwhile has no one to tell and nothing to keep.
    f.storage.updateSession(f.session.id, { deleted: true });
    recordActivity(f.storage, previews, f.session.id, activity, 'state');
    expect(f.events).toHaveLength(2);
  } finally { f.close(); }
});

test('an activity whose process is gone reads idle, a task it left running stopped when the snapshot was taken, its own summary kept', () => {
  const stored = payload([task('a', 'completed', { summary: 'done' }), task('b', 'running'), task('c', 'running', { summary: 'half way' })]);
  const ended = endedActivity(stored);
  expect(ended.state).toBe('idle');
  expect(ended.tasks.map((item) => [item.taskId, item.status, item.endedAt, item.summary])).toEqual([
    ['a', 'completed', '2026-10-24T10:01:00.000Z', 'done'],
    ['b', 'stopped', stored.updatedAt, ENDED_SUMMARY],
    ['c', 'stopped', stored.updatedAt, 'half way'],
  ]);
  expect(ENDED_SUMMARY).toBe('The process ended before it finished');
  expect(stored.tasks[1].status).toBe('running'); // the stored snapshot itself is left as it was
});
