import { expect, test } from 'bun:test';
import { ProtocolError } from '@jolo/protocol';
import { screenCallHandler } from '../src/screen/rpc.js';
import { ToolRegistry } from '../src/tools/registry.js';

/** A hosted run's view of the engine: one live run, a dispatcher script, and a permission queue. */
function fixture({ invokes, pending = null, resolution = null, interactive = 1 }) {
  const calls = [];
  let waiting = pending;
  const controller = new AbortController();
  const storage = {
    getRun: id => ({ id, sessionId: 'ses' }),
    getSession: () => ({ id: 'ses', workspaceId: 'ws' }),
    getWorkspace: () => ({ id: 'ws', path: '/repo' }),
    getArtifact: id => ({ id, sessionId: 'ses', finalizedHash: 'h', committedBytes: 3 }),
    readArtifact: () => ({ buffer: Buffer.from('jpg') }),
  };
  let inflight = 0, overlap = 0;
  const dispatcher = { registry: new ToolRegistry(), async invoke(request) { calls.push(request.call.name); overlap = Math.max(overlap, ++inflight); await Bun.sleep(5); inflight -= 1; const next = invokes.shift(); if (next.status === 'permission_required') waiting = { id: 'perm_1' }; return next; } };
  const revoked = [];
  const permissions = {
    revokeScreen: (workspaceId, runId) => revoked.push({ workspaceId, runId }),
    pendingScreenRequest: () => waiting,
    async waitForResolution(id, signal) {
      if (resolution === 'hang') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ProtocolError('interrupted', 'waited')), { once: true }));
      waiting = null;
      return { id, state: resolution };
    },
  };
  const handler = screenCallHandler({ storage, runs: { active: new Map([['run', { controller }]]) }, dispatcher, permissions, settingsService: { get: () => ({ budgets: { toolDeadlineMs: 120_000 } }) }, interactiveClients: () => interactive });
  const conn = { capability: { runId: 'run', workspaceId: 'ws' }, closeHooks: new Set() };
  return { calls, revoked, overlap: () => overlap, call: (name = 'screen_screenshot') => handler({ workspaceId: 'ws', name, arguments: {} }, conn), conn };
}

const ok = { status: 'ok', output: JSON.stringify({ ok: true, artifactId: 'art', mimeType: 'image/jpeg' }), images: [{ artifactId: 'art', mimeType: 'image/jpeg', width: 1, height: 1, bytes: 3 }] };

test('a hosted call waits for consent, then runs and returns the image beside the JSON', async () => {
  const f = fixture({ invokes: [{ status: 'permission_required', permissionId: 'perm_1', output: null }, ok], resolution: 'allowed' });
  const result = await f.call();
  expect(f.calls).toEqual(['screen_screenshot', 'screen_screenshot']);
  expect(result.isError).toBe(false);
  expect(result.content).toEqual([{ type: 'text', text: ok.output }, { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') }]);
});

test('declined consent is final, and no Jolo window means no one can answer', async () => {
  const declined = fixture({ invokes: [{ status: 'permission_required', permissionId: 'perm_1', output: null }], resolution: 'denied' });
  const refused = await declined.call();
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent.error.code).toBe('permission_denied');
  const alone = fixture({ invokes: [], pending: { id: 'perm_0' }, interactive: 0 });
  expect((await alone.call()).structuredContent.error.code).toBe('permission_required');
  expect(alone.calls).toEqual([]); // an existing request is waited on, never duplicated
});

test('credentials are scoped to the live run and workspace, and only screen tools are admitted', async () => {
  const f = fixture({ invokes: [ok] });
  await expect(f.call('browser_click')).rejects.toMatchObject({ code: 'invalid_params' });
  f.conn.capability.workspaceId = 'other';
  await expect(f.call()).rejects.toMatchObject({ code: 'permission_denied' });
});

test('screen calls issued together run one at a time, in order', async () => {
  const f = fixture({ invokes: [ok, ok, ok] });
  const results = await Promise.all([f.call('screen_screenshot'), f.call('screen_windows'), f.call('screen_screenshot')]);
  expect(results.map(r => r.isError)).toEqual([false, false, false]);
  expect(f.calls).toEqual(['screen_screenshot', 'screen_windows', 'screen_screenshot']);
  expect(f.overlap()).toBe(1);
});

test('when the user takes over, the task\'s consent is withdrawn so the next screen action asks again', async () => {
  const interrupted = { status: 'error', output: JSON.stringify({ ok: false, error: { code: 'user_input', message: 'the user used the mouse' } }), images: [], userInterrupted: true };
  const f = fixture({ invokes: [interrupted, ok] });
  const first = await f.call('screen_pointer');
  expect(first.isError).toBe(true);
  expect(f.revoked).toEqual([{ workspaceId: 'ws', runId: 'run' }]);
  expect((await f.call()).isError).toBe(false);
  expect(f.revoked).toHaveLength(1); // a normal action withdraws nothing
});
