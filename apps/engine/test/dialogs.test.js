import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DialogSchema, ProtocolError } from '@jolo/protocol';
import { Storage } from '../src/storage/index.js';
import { createDialogService } from '../src/dialogs/service.js';
import { dialogControlResponse, isDialogRequest } from '../src/agents/claude-dialogs.js';

/** The code of the error `fn` throws, or null when it throws none. */
const thrown = (fn) => { try { fn(); } catch (error) { return error?.code ?? String(error); } return null; };

const INPUT = { questions: [{ question: 'q', header: 'Choice', options: [{ label: 'tea', description: '' }, { label: 'coffee', description: '' }], multiSelect: false }] };

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-dialogs-'));
  const open = () => new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const storage = open();
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Asked' });
  const run = storage.insertRun({ sessionId: session.id, requestId: 'ask', prompt: 'ask me' });
  const events = [];
  storage.events.on('event', event => events.push(event));
  const service = createDialogService({ storage });
  const ask = () => service.request({ run, requestId: 'req-1', tool: 'AskUserQuestion', toolUseId: 'toolu_1', input: INPUT });
  return { root, open, storage, session, run, events, service, ask, close() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('a dialog is recorded and published with what Claude asked', () => {
  const f = fixture();
  try {
    const dialog = f.ask();
    expect(DialogSchema.safeParse(dialog).success).toBe(true);
    expect(dialog).toMatchObject({ sessionId: f.session.id, runId: f.run.id, requestId: 'req-1', tool: 'AskUserQuestion', toolUseId: 'toolu_1', input: INPUT, response: null, state: 'requested', resolvedAt: null });
    const requested = f.events.find(event => event.type === 'dialog.requested');
    expect(requested).toMatchObject({ sessionId: f.session.id, runId: f.run.id, payload: { dialogId: dialog.id, runId: f.run.id, tool: 'AskUserQuestion', input: INPUT, toolUseId: 'toolu_1' } });
  } finally { f.close(); }
});

test('an answer settles the wait, is published once, and a second answer is a conflict', async () => {
  const f = fixture();
  try {
    const dialog = f.ask();
    const waiting = f.service.waitForResolution(dialog.id, new AbortController().signal);
    const answered = f.service.resolve(dialog.id, { answers: { q: 'coffee' } });
    expect(answered).toMatchObject({ state: 'answered', response: { answers: { q: 'coffee' } } });
    const settled = await waiting;
    expect(settled).toMatchObject({ id: dialog.id, state: 'answered', response: { answers: { q: 'coffee' } } });
    expect(settled.resolvedAt).not.toBeNull();
    expect(f.events.filter(event => event.type === 'dialog.resolved').map(event => event.payload)).toEqual([{ dialogId: dialog.id, state: 'answered' }]);
    expect(() => f.service.resolve(dialog.id, {})).toThrow(ProtocolError);
    expect(thrown(() => f.service.resolve(dialog.id, {}))).toBe('conflict');
    expect(thrown(() => f.service.dismiss(dialog.id, 'too late'))).toBe('conflict');
    expect(thrown(() => f.service.resolve('dlg_unknown', {}))).toBe('not_found');
    expect(dialogControlResponse(settled)).toEqual({ behavior: 'allow', updatedInput: { ...INPUT, answers: { q: 'coffee' } } });
  } finally { f.close(); }
});

test('dismissing a dialog settles it as dismissed with the message Claude is told', async () => {
  const f = fixture();
  try {
    const dialog = f.ask();
    const waiting = f.service.waitForResolution(dialog.id, new AbortController().signal);
    f.service.dismiss(dialog.id, 'Not now.');
    const settled = await waiting;
    expect(settled).toMatchObject({ state: 'dismissed', response: { message: 'Not now.' } });
    expect(dialogControlResponse(settled)).toEqual({ behavior: 'deny', message: 'Not now.' });
    expect(f.events.filter(event => event.type === 'dialog.resolved').map(event => event.payload.state)).toEqual(['dismissed']);
  } finally { f.close(); }
});

test('a wait whose signal aborts rejects and leaves the dialog cancelled, with nothing for Claude', async () => {
  const f = fixture();
  try {
    const dialog = f.ask();
    const controller = new AbortController();
    const waiting = f.service.waitForResolution(dialog.id, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(ProtocolError);
    const cancelled = f.service.get(dialog.id);
    expect(cancelled.state).toBe('cancelled');
    expect(dialogControlResponse(cancelled)).toBeNull();
    expect(f.events.filter(event => event.type === 'dialog.resolved').map(event => event.payload)).toEqual([{ dialogId: dialog.id, state: 'cancelled' }]);
    expect(thrown(() => f.service.resolve(dialog.id, {}))).toBe('conflict');
    // Already aborted before the wait begins: the same.
    const again = f.service.request({ run: f.run, requestId: 'req-2', tool: 'ExitPlanMode', toolUseId: null, input: { plan: 'p' } });
    await expect(f.service.waitForResolution(again.id, AbortSignal.abort())).rejects.toBeInstanceOf(ProtocolError);
    expect(f.service.get(again.id).state).toBe('cancelled');
  } finally { f.close(); }
});

test('a dialog still open when the engine restarts is cancelled: nobody can answer it any more', () => {
  const f = fixture();
  try {
    const dialog = f.ask();
    f.storage.close();
    const storage = f.open();
    try {
      createDialogService({ storage });
      expect(storage.dialogs.get(dialog.id).state).toBe('cancelled');
    } finally { storage.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Claude needs the person for its questions and plan approval, and for anything it marks as needing them', () => {
  expect(isDialogRequest({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: INPUT })).toBe(true);
  expect(isDialogRequest({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'p' } })).toBe(true);
  expect(isDialogRequest({ subtype: 'can_use_tool', tool_name: 'SomethingNew', input: {}, requires_user_interaction: true })).toBe(true);
  expect(isDialogRequest({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } })).toBe(false);
  expect(dialogControlResponse({ tool: 'ExitPlanMode', input: { plan: 'p' }, response: {}, state: 'answered' })).toEqual({ behavior: 'allow', updatedInput: { plan: 'p' } });
});
