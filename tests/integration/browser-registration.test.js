import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { BROWSER_OPERATIONS } from '@jolo/protocol';
import { createBrowserAgent } from '../../apps/desktop/src/main/browser-agent.js';
import { createBrowserOpener } from '../../apps/desktop/src/main/browser-opener.js';

const legacy = ['navigate', 'snapshot', 'click', 'type', 'screenshot', 'network', 'fill', 'press', 'scroll', 'hover', 'select', 'history'];

function fixture(supportedBrowserOperations = undefined) {
  const calls = [], replies = [];
  let failure = null, destroyed = false;
  const bridge = {
    client: { hello: { supportedBrowserOperations } },
    async rawCall(method, params) {
      if (method === 'browser.register') {
        calls.push(params);
        if (failure) throw new Error(failure);
        // Reproduce a legacy engine rejecting new enum values before registration.
        if (params.operations.some(operation => !(bridge.client.hello.supportedBrowserOperations ?? legacy).includes(operation))) throw new Error('invalid browser operation');
        return { capabilityId: 'cap' };
      }
      if (method === 'browser.openResult') replies.push(params);
      return {};
    },
  };
  const guest = Object.assign(new EventEmitter(), {
    id: 1, getURL: () => 'about:blank', getTitle: () => '', isDestroyed: () => destroyed,
    debugger: Object.assign(new EventEmitter(), { async sendCommand() { return {}; } }),
  });
  const log = { info() {}, warn() {} };
  const agent = createBrowserAgent({ bridge, log, isOverlayActive: () => false, nativeImage: null });
  const opener = createBrowserOpener({ bridge, agent, log, send() {}, isOverlayActive: () => false });
  opener.setWorkspaces({ workspaceIds: ['ws'] });
  return { agent, opener, guest, bridge, calls, replies, fail: value => { failure = value; }, destroy: () => { destroyed = true; guest.emit('destroyed'); } };
}

test('a new desktop opens its browser against an engine without operation negotiation', async () => {
  const f = fixture();
  f.opener.handleOpen({ invocationId: 'open', workspaceId: 'ws', leaseMs: 1000 });
  f.opener.acknowledge({ invocationId: 'open' });
  f.agent.attach(f.guest, 'ws');
  await Bun.sleep(0);
  expect(f.calls[0].operations).toEqual(legacy);
  expect(f.replies).toEqual([{ invocationId: 'open', capabilityId: 'cap' }]);
  f.destroy();
});

test('registration negotiates supported operations again after the engine is upgraded', async () => {
  const f = fixture();
  const host = f.agent.attach(f.guest, 'ws');
  await Bun.sleep(0);
  f.agent.onDisconnected();
  expect(host.capabilityId).toBeNull();
  f.bridge.client.hello.supportedBrowserOperations = [...BROWSER_OPERATIONS, 'future-operation'];
  await f.agent.onConnected();
  expect(f.calls.at(-1).operations).toEqual([...BROWSER_OPERATIONS]);
  expect(host.capabilityId).toBe('cap');
  f.destroy();
});

test('a limited advertised operation set is honored', async () => {
  const f = fixture(['navigate', 'snapshot']);
  f.agent.attach(f.guest, 'ws');
  await Bun.sleep(0);
  expect(f.calls[0].operations).toEqual(['navigate', 'snapshot']);
  f.destroy();
});

test('registration errors reach browser_open immediately in either acknowledgement order, and retry can recover', async () => {
  for (const acknowledgeFirst of [true, false]) {
    const f = fixture();
    f.fail('engine rejected browser registration');
    f.opener.handleOpen({ invocationId: 'failed', workspaceId: 'ws', leaseMs: 1000 });
    if (acknowledgeFirst) f.opener.acknowledge({ invocationId: 'failed' });
    f.agent.attach(f.guest, 'ws');
    await Bun.sleep(0);
    if (!acknowledgeFirst) f.opener.acknowledge({ invocationId: 'failed' });
    expect(f.replies).toEqual([{ invocationId: 'failed', error: 'Inline browser registration failed: engine rejected browser registration' }]);
    f.fail(null);
    f.opener.handleOpen({ invocationId: 'retry', workspaceId: 'ws', leaseMs: 1000 });
    f.opener.acknowledge({ invocationId: 'retry' });
    await Bun.sleep(0);
    expect(f.replies.at(-1)).toEqual({ invocationId: 'retry', capabilityId: 'cap' });
    expect(f.calls).toHaveLength(2);
    f.destroy();
  }
});


test('a transient opener publication failure recovers without reopening the chat or restarting', async () => {
  const workspaces = []; let attempts = 0;
  const bridge = { client: { connected: true, closed: false }, async rawCall(method, params) {
    if (method !== 'browser.setOpener') return {};
    attempts++;
    if (attempts === 1) throw new Error('temporary registration rejection');
    workspaces.push(params.workspaceIds);
    return { registered: true };
  } };
  const agent = { hosts: new Map(), onRegistered() {}, onRegistrationFailed() {} };
  const opener = createBrowserOpener({ bridge, agent, send() {}, isOverlayActive: () => false, log: { warn() {} }, retryMs: 5 });
  opener.setWorkspaces({ workspaceIds: ['chat-workspace'] });
  for (let i = 0; i < 100 && !workspaces.length; i++) await Bun.sleep(5);
  expect(attempts).toBe(2);
  expect(workspaces).toEqual([['chat-workspace']]);
  opener.onDisconnected();
});
