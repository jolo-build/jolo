import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Storage } from '../../apps/engine/src/storage/index.js';
import { createRpcServer } from '../../apps/engine/src/rpc/server.js';
import { CapabilityTokens } from '../../apps/engine/src/rpc/capabilities.js';
import { connect } from '../../packages/client/src/index.js';

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
