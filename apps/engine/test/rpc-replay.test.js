import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Storage } from '../src/storage/index.js';
import { createRpcServer } from '../src/rpc/server.js';
import { CapabilityTokens } from '../src/rpc/capabilities.js';
import { connect } from '../../../packages/client/src/index.js';

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'j-rpc-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'boot' });
  const capabilities = new CapabilityTokens(path.join(root, 'caps'));
  const options = { socketPath: path.join(root, 's'), token: 'owner-token-1234567890', clientKind: 'test' };
  const server = createRpcServer({ token: options.token, capabilityTokens: capabilities, bootId: 'boot', build: 'test', storage, previews: new EventEmitter(), lifetime: { clientConnected() {}, clientDisconnected() {} }, log: { error() {}, warn() {} }, handlers: {} });
  await server.listen(options.socketPath);
  return { storage, capabilities, options, async close() { await server.close(); storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('multi-megabyte replay drains without disconnect and hands off live events exactly once', async () => {
  const f = await fixture();
  try {
    f.storage.transaction(() => { for (let i = 0; i < 4000; i++) f.storage.appendEvent({ type: 'grant.created', payload: { grantId: `g${i}`, scope: 'inspect', extra: 'x'.repeat(1024) } }); });
    const client = await connect(f.options), seen = [];
    const replay = client.subscribe({ after: '0' }, { onEvent(event) { seen.push(event.eventSeq); if (seen.length === 20) f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'live', scope: 'inspect' } }); } });
    await replay;
    expect(seen).toHaveLength(4001);
    expect(new Set(seen).size).toBe(4001);
    expect(seen.at(-1)).toBe('4001');
    expect(client.closed).toBe(false);
    await expect(client.subscribe({ after: '0' })).rejects.toMatchObject({ code: 'conflict' });
    await client.close();
  } finally { await f.close(); }
}, 15000);

test('retained history rejects old and future cursors with explicit resync', async () => {
  const f = await fixture();
  try {
    f.storage.transaction(() => { for (let i = 0; i < 12; i++) f.storage.appendEvent({ type: 'grant.created', payload: { grantId: `g${i}`, scope: 'inspect' } }); });
    f.storage.eventRepository.prune(4);
    const client = await connect(f.options);
    await expect(client.subscribe({ after: '0' })).rejects.toMatchObject({ code: 'resync_required' });
    await expect(client.subscribe({ after: '99' })).rejects.toMatchObject({ code: 'resync_required' });
    expect(f.storage.maxSeq()).toBe('12');
    await client.close();
  } finally { await f.close(); }
});

test('guest credential cannot claim interactive authority, cross workspaces, or survive revocation', async () => {
  const f = await fixture();
  try {
    const entry = f.capabilities.issue('run', 'workspace');
    const browser = f.capabilities.issue('run', 'workspace', ['browser.call']);
    expect(browser.tokenPath).not.toBe(entry.tokenPath);
    expect(entry.methods).toEqual(['workspace.search']);
    const browserClient = await connect({ ...f.options, token: readFileSync(browser.tokenPath, 'utf8'), clientKind: 'desktop' });
    await expect(browserClient.call('browser.call', { workspaceId: 'other', name: 'browser_tabs', arguments: {} })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(browserClient.call('workspace.search', { workspaceId: 'workspace', pattern: 'test' })).rejects.toMatchObject({ code: 'unknown_method' });
    const client = await connect({ ...f.options, token: readFileSync(entry.tokenPath, 'utf8'), clientKind: 'test' });
    await expect(client.call('permission.resolve', { permissionId: 'p', decision: 'allow_once' })).rejects.toMatchObject({ code: 'unknown_method' });
    await expect(client.call('workspace.search', { workspaceId: 'other', pattern: 'test' })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(client.call('task.list', {})).rejects.toMatchObject({ code: 'unknown_method' });
    await expect(client.call('task.get', { key: 'JOLO-1' })).rejects.toMatchObject({ code: 'unknown_method' });
    f.capabilities.revoke('run');
    await expect(browserClient.call('browser.call', { workspaceId: 'workspace', name: 'browser_tabs', arguments: {} })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.call('workspace.search', { workspaceId: 'workspace', pattern: 'test' })).rejects.toMatchObject({ code: 'unavailable' });
    await client.close();
  } finally { await f.close(); }
});

test('event-type negotiation filters replay and live; undeclared subscribers keep the legacy set', async () => {
  const f = await fixture();
  try {
    const stamp = new Date().toISOString();
    const scheduleEvent = (id) => ({ type: 'schedule.updated', payload: { schedule: { id, sessionId: 'ses_x', prompt: 'wake', everyMs: 60_000, state: 'active', fireCount: 0, nextFireAt: stamp, lastRunId: null, lastError: null, createdAt: stamp, updatedAt: stamp } } });
    f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'g1', scope: 'inspect' } });
    f.storage.appendEvent(scheduleEvent('s1'));

    // A legacy client declares nothing: replay and live carry only the original event set.
    const legacy = await connect(f.options), legacySeen = [];
    legacy.onEvent(event => legacySeen.push(event.type));
    const legacyResult = await legacy.call('events.subscribe', { after: '0' });
    expect(legacyResult.replayed).toBe(1);
    expect(legacySeen).toEqual(['grant.created']);

    // A client that declares one type sees only it, in replay and live.
    const typed = await connect(f.options), typedSeen = [];
    typed.onEvent(event => typedSeen.push(event.type));
    const typedResult = await typed.call('events.subscribe', { after: '0', eventTypes: ['schedule.updated'] });
    expect(typedResult.replayed).toBe(1);
    expect(typedSeen).toEqual(['schedule.updated']);

    f.storage.appendEvent({ type: 'grant.created', payload: { grantId: 'g2', scope: 'inspect' } });
    f.storage.appendEvent(scheduleEvent('s2'));
    for (let i = 0; i < 40 && (legacySeen.length < 2 || typedSeen.length < 2); i++) await Bun.sleep(25);
    expect(legacySeen).toEqual(['grant.created', 'grant.created']);
    expect(typedSeen).toEqual(['schedule.updated', 'schedule.updated']);

    // The current client declares every type it knows, so new event types reach it.
    const modern = await connect(f.options), modernSeen = [];
    await modern.subscribe({ after: '0' }, { onEvent: event => modernSeen.push(event.type) });
    expect(modernSeen.sort()).toEqual(['grant.created', 'grant.created', 'schedule.updated', 'schedule.updated'].sort());
    await legacy.close(); await typed.close(); await modern.close();
  } finally { await f.close(); }
}, 15000);
