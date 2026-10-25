// The relay Durable Object in real workerd: WebSocket pairs, hibernation tags and attachments,
// the ping auto-response, replacement, revocation and D1 status writes. Nothing is deployed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { unstable_splitSqlQuery: splitSQL } = require('wrangler');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const source = new URL('../src/', import.meta.url);
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'relay-runtime', compatibilityDate: '2026-09-09', modulesRoot: fileURLToPath(source),
  d1Databases: { ACCESS_DB: 'relay-fixture' },
  durableObjects: { ACCESS_RELAY: { className: 'AccountRelay', useSQLite: true } },
  modules: [
    { type: 'ESModule', path: fileURLToPath(new URL('relay-runtime.js', source)), contents: `
      import { relayFor } from './relay.js';
      export { AccountRelay } from './relay.js';
      export default { async fetch(request, env) {
        const url = new URL(request.url), relay = relayFor(env, 'account');
        if (url.pathname === '/connect') return relay.connect({ id: 'device', name: 'Laptop', accountId: 'account' });
        if (url.pathname === '/online') return Response.json(await relay.online());
        if (url.pathname === '/send') return Response.json(await relay.send('device', { type: 'prompt', id: 'fixture' }));
        if (url.pathname === '/disconnect') return Response.json(await relay.disconnect('device'));
        if (url.pathname === '/live') return Response.json(await relay.live(url.searchParams.get('id')));
        return new Response(null, { status: 404 });
      } };` },
    { type: 'ESModule', path: fileURLToPath(new URL('relay.js', source)), contents: readFileSync(new URL('relay.js', source), 'utf8') },
  ],
}));

const next = (socket, type) => new Promise(resolve => socket.addEventListener(type, resolve, { once: true }));
const json = async path => (await runtime.dispatchFetch(`https://relay.test${path}`)).json();
const connect = async () => {
  const response = await runtime.dispatchFetch('https://relay.test/connect', { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  response.webSocket.accept();
  return response.webSocket;
};
const settle = async (check) => { for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('relay did not settle'); };

try {
  const db = await runtime.getD1Database('ACCESS_DB');
  const migrations = new URL('../.generated/migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
    await db.batch(splitSQL(readFileSync(new URL(name, migrations), 'utf8')).map(statement => db.prepare(statement)));
  }
  const prompt = crypto.randomUUID(), folder = crypto.randomUUID();
  await db.prepare("INSERT INTO accounts (id,provider_key,email,name,created_at,updated_at) VALUES ('account','github:1','a@example.com','A',0,0)").run();
  await db.prepare("INSERT INTO remote_prompts (id,account_id,device_id,device_name,chat_id,text,status,created_at,updated_at) VALUES (?1,'account','device','Laptop',?2,'Fix it','delivered',0,0)").bind(prompt, crypto.randomUUID()).run();

  const first = await connect();
  // What a device reports lives in object storage, not its socket attachment (16 KiB at most).
  const folders = [folder, ...Array.from({ length: 99 }, () => crypto.randomUUID())];
  first.send(JSON.stringify({ type: 'hello', folders: [...folders, '../not-an-id'], approvals: true }));
  await settle(async () => (await json('/online'))[0]?.folders.length === 100);
  assert.deepEqual(await json('/online'), [{ id: 'device', name: 'Laptop', folders, approvals: true }]);

  const delivered = next(first, 'message');
  assert.equal(await json('/send'), true);
  assert.deepEqual(JSON.parse((await delivered).data), { type: 'prompt', id: 'fixture' });

  const pong = next(first, 'message');
  first.send('ping');
  assert.equal((await pong).data, 'pong');

  const permission = async () => JSON.parse((await db.prepare('SELECT permission FROM remote_prompts WHERE id=?').bind(prompt).first()).permission);
  first.send(JSON.stringify({ type: 'status', id: prompt, status: 'awaiting_permission', permission: { id: 'perm_1', tool: 'run_command', summary: 'Run a command', command: 'echo hi', complete: true } }));
  await settle(async () => (await db.prepare('SELECT status FROM remote_prompts WHERE id=?').bind(prompt).first()).status === 'awaiting_permission');
  assert.deepEqual(await permission(), { id: 'perm_1', tool: 'run_command', summary: 'Run a command', command: 'echo hi', complete: true });
  // A command cut to fit is never offered for approval on the web, whatever the device says.
  first.send(JSON.stringify({ type: 'status', id: prompt, status: 'awaiting_permission', permission: { id: 'perm_2', tool: 'run_command', summary: 'Long', command: 'x'.repeat(5000), complete: true } }));
  await settle(async () => (await permission()).id === 'perm_2');
  assert.equal((await permission()).complete, false);
  assert.equal((await permission()).command.length, 4000);
  first.send(JSON.stringify({ type: 'status', id: prompt, status: 'running' }));
  await settle(async () => (await db.prepare('SELECT status FROM remote_prompts WHERE id=?').bind(prompt).first()).status === 'running');
  assert.equal((await db.prepare('SELECT permission FROM remote_prompts WHERE id=?').bind(prompt).first()).permission, null);
  // Live text is kept for the device's own active prompt, and not for anyone else's.
  const stranger = crypto.randomUUID();
  first.send(JSON.stringify({ type: 'live', id: stranger, text: 'not mine' }));
  first.send(JSON.stringify({ type: 'live', id: prompt, text: 'Working on it' }));
  await settle(async () => await json(`/live?id=${prompt}`) === 'Working on it');
  assert.equal(await json(`/live?id=${stranger}`), null);
  first.send(JSON.stringify({ type: 'status', id: prompt, status: 'completed' }));
  // A device still reporting a prompt the web ended is told to stop the run.
  const stop = next(first, 'message');
  first.send(JSON.stringify({ type: 'status', id: prompt, status: 'running' }));
  assert.deepEqual(JSON.parse((await stop).data), { type: 'cancel', id: prompt });
  await settle(async () => (await db.prepare('SELECT status FROM remote_prompts WHERE id=?').bind(prompt).first()).status === 'completed');
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await db.prepare('SELECT status FROM remote_prompts WHERE id=?').bind(prompt).first()).status, 'completed', 'a finished prompt cannot be reopened');
  assert.equal(await json(`/live?id=${prompt}`), null, 'live text ends with the prompt');

  const replaced = next(first, 'close');
  const second = await connect();
  assert.equal((await replaced).code, 4000);
  second.send(JSON.stringify({ type: 'hello', folders: [] }));
  await settle(async () => (await json('/online')).length === 1 && (await json('/online'))[0].folders.length === 0);

  const revoked = next(second, 'close');
  await json('/disconnect');
  assert.equal((await revoked).code, 4001);
  await settle(async () => (await json('/online')).length === 0);
  assert.equal(await json('/send'), false);
  console.log('Relay runtime checks passed: WebSocket upgrade, presence with 100 folders and approvals, delivery, ping auto-response, permission and status writes, shortened requests, stopping ended prompts, live text ownership, replacement and revocation.');
} finally {
  await runtime.dispose();
}
