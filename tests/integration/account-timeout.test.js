import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { startEngine, tempHome } from './helpers.js';

test('account login returns the server connection error before the RPC deadline and can retry', async () => {
  let slow = true;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    if (slow) await Bun.sleep(11_000);
    return Response.json({ error: 'unavailable' }, { status: 503 });
  } });
  const home = tempHome();
  let engine, client;
  try {
    engine = await startEngine({ home, env: { JOLO_CREDENTIALS: 'session', JOLO_ACCOUNT_ORIGIN: server.url.origin } });
    client = await engine.connect({ clientKind: 'desktop' });
    await expect(client.call('account.login')).rejects.toMatchObject({
      code: 'unavailable', message: 'Could not reach the account server. Check the connection and try again.',
    });
    expect((await client.call('account.status')).state).toBe('signed_out');
    slow = false;
    await expect(client.call('account.login')).rejects.toThrow('The account service could not start sign-in.');
  } finally {
    await client?.close(); await engine?.stop(); server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
