import { expect, test } from 'bun:test';
import { sessionForSend, queuedExecution } from '../src/renderer/session-send.js';

test('changing answerers uses the existing session and its latest revision', async () => {
  const original = { id: 'existing', workspaceId: 'worktree', title: 'My task', agentId: 'codex', revision: 19 };
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session.page') return { session: original, messages: [{ id: 'history' }] };
    if (method === 'session.setAgent') return { session: { ...original, agentId: params.agentId, revision: 20 } };
    throw new Error(`unexpected ${method}`);
  };
  const newSession = () => { throw new Error('must not create a session'); };
  const result = await sessionForSend({ call, sessionId: original.id, agentId: 'grok', prompt: 'continue', newSession });
  expect(result).toMatchObject({ id: 'existing', workspaceId: 'worktree', title: 'My task', agentId: 'grok' });
  expect(calls[1]).toEqual({ method: 'session.setAgent', params: { sessionId: 'existing', agentId: 'grok', expectedRevision: 19 } });
});

test('changing a model within the same agent does not switch or recreate the session', async () => {
  const calls = [];
  const result = await sessionForSend({ sessionId: 'existing', agentId: 'codex', prompt: 'continue', newSession() { throw new Error('new session'); }, call: async method => {
    calls.push(method); return { session: { id: 'existing', agentId: 'codex', revision: 3 } };
  } });
  expect(result.id).toBe('existing');
  expect(calls).toEqual(['session.page']);
});

test('an unfinished-run conflict propagates without creating a replacement session', async () => {
  await expect(sessionForSend({ sessionId: 'existing', agentId: null, prompt: 'continue', newSession() { throw new Error('replacement session'); }, call: async method => {
    if (method === 'session.page') return { session: { id: 'existing', agentId: 'codex', revision: 3 } };
    throw new Error('Finish or stop the current task before switching agents');
  } })).rejects.toThrow('Finish or stop');
});

test('a new draft creates exactly one session with its selected answerer', async () => {
  let created = 0;
  const result = await sessionForSend({ sessionId: null, agentId: 'codex', prompt: 'start here', call() { throw new Error('unexpected call'); }, newSession(title, options) {
    created++; expect(title).toBe('start here'); expect(options.agentId).toBe('codex'); return { id: 'new' };
  } });
  expect(result.id).toBe('new');
  expect(created).toBe(1);
});

test('a new draft preserves an explicit native answerer over the remembered agent', async () => {
  await sessionForSend({ sessionId: null, agentId: null, prompt: 'start here', call() { throw new Error('unexpected call'); }, newSession(_title, options) {
    expect(options.agentId).toBeNull();
    return { id: 'new' };
  } });
});

test('queued answerer choices keep @mention routing and the session default intact', () => {
  expect(queuedExecution('grok', 'grok', 'continue')).toBeUndefined();
  expect(queuedExecution('grok', 'grok', '@codex check this')).toBeUndefined();
  expect(queuedExecution('claude', 'grok', '@codex check this')).toBeUndefined();
  expect(queuedExecution('claude', 'grok', 'check this')).toEqual({ agentId: 'claude' });
  expect(queuedExecution(null, 'grok', 'check this')).toEqual({ agentId: 'jolo' });
});
