import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseResult } from '@jolo/protocol';
import { Storage } from '../src/storage/index.js';
import { createBoard } from '../src/board/index.js';

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-task-revisions-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  cleanups.push(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const folders = ['alpha', 'beta', 'chat'].map(name => {
    const project = storage.upsertProject({ identity: name, rootPath: path.join(root, name) });
    if (name === 'chat') storage.setProjectPreferences(project.id, { standalone: true });
    const workspace = storage.ensureDirectWorkspace(project.id, project.rootPath);
    const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: name });
    return { project, workspace, session };
  });
  const create = () => createBoard({ storage, env: { git: null, path: '' }, log: null });
  const board = create();
  const read = async () => {
    const parsed = parseResult('board.list', await board.list());
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  return { storage, folders, board, create, read };
}
const revision = (board, folder) => board.projects.find(row => row.workspaceId === folder.workspace.id)?.tasksRevision;

test('board refreshes and tool/file activity keep task revisions stable across the protocol', async () => {
  const { storage, folders: [alpha], read } = fixture();
  const first = await read();
  expect(first.tasksRevision).toBeString();
  expect(revision(first, alpha)).toBeString();
  for (let index = 0; index < 20; index++) {
    storage.appendEvent({ sessionId: alpha.session.id, type: 'tool.started', payload: { invocationId: `inv-${index}`, callId: `call-${index}`, name: 'read_file', argumentDigest: 'digest', preview: 'read file' } });
    storage.appendEvent({ sessionId: alpha.session.id, type: 'files.changed', payload: { invocationId: `inv-${index}`, tool: 'replace_exact', changes: [] } });
    const next = await read();
    expect(next.tasksRevision).toBe(first.tasksRevision);
    expect(next.standaloneTasksRevision).toBe(first.standaloneTasksRevision);
    expect(revision(next, alpha)).toBe(revision(first, alpha));
  }
});

test('a task outside the board summary invalidates only its workspace and the global list', async () => {
  const { storage, folders: [alpha, beta, chat], read } = fixture();
  const other = storage.createSession({ projectId: alpha.project.id, workspaceId: alpha.workspace.id, title: 'Older task' });
  const first = await read();
  const session = storage.updateSession(other.id, { title: 'Renamed task' });
  storage.appendEvent({ sessionId: other.id, type: 'session.updated', payload: { session } });
  const next = await read();
  expect(revision(next, alpha)).not.toBe(revision(first, alpha));
  expect(next.tasksRevision).not.toBe(first.tasksRevision);
  expect(revision(next, beta)).toBe(revision(first, beta));
  expect(revision(next, chat)).toBe(revision(first, chat));
  expect(next.standaloneTasksRevision).toBe(first.standaloneTasksRevision);
});

test('run transitions, usage timestamps, and viewed status invalidate the owning task list', async () => {
  const { storage, folders: [alpha, beta], board, read } = fixture();
  const run = storage.insertRun({ sessionId: alpha.session.id, requestId: 'run', prompt: 'Task' });
  let previous = await read();
  for (const state of ['model', 'awaiting_permission', 'paused', 'completed']) {
    const updated = storage.updateRunState(run.id, state);
    storage.appendEvent({ sessionId: alpha.session.id, runId: run.id, type: 'run.state', payload: { state, revision: updated.revision } });
    const next = await read();
    expect(revision(next, alpha)).not.toBe(revision(previous, alpha));
    expect(revision(next, beta)).toBe(revision(previous, beta));
    previous = next;
  }
  storage.updateRunUsage(run.id, { inputTokens: 1 });
  storage.appendEvent({ sessionId: alpha.session.id, runId: run.id, type: 'run.usage', payload: { inputTokens: 1 } });
  const usage = await read();
  expect(revision(usage, alpha)).not.toBe(revision(previous, alpha));
  board.viewed(alpha.workspace.id);
  expect(revision(await read(), alpha)).not.toBe(revision(usage, alpha));
});

test('create, archive, restore, and delete update standalone lists without invalidating folders', async () => {
  const { storage, folders: [alpha, , chat], read } = fixture();
  let previous = await read();
  const check = async () => {
    const next = await read();
    expect(next.standaloneTasksRevision).not.toBe(previous.standaloneTasksRevision);
    expect(next.tasksRevision).not.toBe(previous.tasksRevision);
    expect(revision(next, alpha)).toBe(revision(previous, alpha));
    previous = next;
  };
  const session = storage.createSession({ projectId: chat.project.id, workspaceId: chat.workspace.id, title: 'New chat' });
  storage.appendEvent({ sessionId: session.id, type: 'session.created', payload: { session } });
  await check();
  for (const state of ['archived', 'open']) {
    const updated = storage.updateSession(session.id, { state });
    storage.appendEvent({ sessionId: session.id, type: 'session.updated', payload: { session: updated } });
    await check();
  }
  storage.updateSession(session.id, { deleted: true });
  expect(storage.getSession(session.id)).toBeNull();
  storage.appendEvent({ sessionId: session.id, type: 'session.deleted', payload: { sessionId: session.id, projectId: chat.project.id } });
  await check();
});

test('folder removal and metadata changes invalidate global membership and task destinations', async () => {
  const { storage, folders: [alpha, beta, chat], read } = fixture();
  const first = await read();
  storage.setProjectPreferences(chat.project.id, { standalone: false });
  const linked = await read();
  expect(linked.standaloneTasksRevision).not.toBe(first.standaloneTasksRevision);
  expect(linked.tasksRevision).not.toBe(first.tasksRevision);
  storage.markWorkspaceRemoved(alpha.workspace.id);
  const removed = await read();
  expect(removed.tasksRevision).not.toBe(linked.tasksRevision);
  expect(revision(removed, beta)).toBe(revision(first, beta));
});

test('a fresh board service invalidates cached lists; rolled-back events do not', async () => {
  const { storage, folders: [alpha], create, read } = fixture();
  const first = await read();
  expect(() => storage.transaction(() => {
    const session = storage.updateSession(alpha.session.id, { title: 'Rolled back' });
    storage.appendEvent({ sessionId: session.id, type: 'session.updated', payload: { session } });
    throw new Error('rollback');
  })).toThrow('rollback');
  expect((await read()).tasksRevision).toBe(first.tasksRevision);
  const restarted = await create().list();
  expect(restarted.tasksRevision).not.toBe(first.tasksRevision);
  expect(restarted.standaloneTasksRevision).not.toBe(first.standaloneTasksRevision);
});
