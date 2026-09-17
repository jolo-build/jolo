import { expect, test } from 'bun:test';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFrame, createFrameDecoder, PROTOCOL_VERSION, EVENT_TYPES } from '@jolo/protocol';
import { connect } from '../src/index.js';

/**
 * A stub engine: answers hello with the given extra fields, then records what subscribe sent.
 * `strict` models an engine that predates event-type negotiation — it rejects unknown fields.
 */
async function stubEngine({ helloExtra = {}, strict = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-compat-'));
  const socketPath = path.join(root, 's');
  const subscriptions = [];
  const server = net.createServer((socket) => {
    const decode = createFrameDecoder({
      onMessage(message) {
        if (message.method === 'hello') {
          socket.write(encodeFrame({
            jsonrpc: '2.0', id: message.id,
            result: {
              protocol: PROTOCOL_VERSION, schemaVersion: 1, build: 'stub', engineBootId: 'boot',
              supportedMethods: ['hello', 'events.subscribe'],
              frameLimits: { maxFrameBytes: 262144, maxBufferedBytes: 524288 },
              ...helloExtra,
            },
          }));
          return;
        }
        if (message.method === 'events.subscribe') {
          subscriptions.push(message.params ?? {});
          if (strict && message.params && 'eventTypes' in message.params) {
            socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown fields for events.subscribe', data: { code: 'invalid_params' } } }));
            return;
          }
          socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: { cursor: '0', replayed: 0 } }));
        }
      },
      onError() { socket.destroy(); },
    });
    socket.on('data', decode);
  });
  await new Promise((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath, subscriptions,
    async close() { await new Promise((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
  };
}

const options = (socketPath) => ({ socketPath, token: 'owner-token-1234567890', clientKind: 'test' });

test('an engine that predates negotiation gets a legacy subscribe', async () => {
  const stub = await stubEngine({ strict: true }); // an unknown eventTypes field is rejected outright
  try {
    const client = await connect(options(stub.socketPath));
    await client.subscribe({ after: '0' });
    expect(stub.subscriptions).toEqual([{ after: '0' }]);
    await client.close();
  } finally { await stub.close(); }
});

test('an engine that advertises event types receives the client’s declared set', async () => {
  const stub = await stubEngine({ helloExtra: { supportedEventTypes: [...EVENT_TYPES] } });
  try {
    const client = await connect(options(stub.socketPath));
    await client.subscribe({ after: '0' });
    expect(stub.subscriptions).toEqual([{ after: '0', eventTypes: [...EVENT_TYPES] }]);
    await client.close();
  } finally { await stub.close(); }
});

test('caller-supplied event types win over the declared set', async () => {
  const stub = await stubEngine({ helloExtra: { supportedEventTypes: [...EVENT_TYPES] } });
  try {
    const client = await connect(options(stub.socketPath));
    await client.subscribe({ after: '0', eventTypes: ['schedule.updated'] });
    expect(stub.subscriptions).toEqual([{ after: '0', eventTypes: ['schedule.updated'] }]);
    await client.close();
  } finally { await stub.close(); }
});
