import { expect, test } from 'bun:test';
import { fixture } from '../../apps/access/test/fixture.js';
import { AccountRelay } from '../../apps/access/src/relay.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, removeHome, openSession, waitFor } from './helpers.js';

// Bun has no Durable Objects. This host gives the real relay class the calls workerd makes
// (tags, attachments, ping timestamps); scripts/test-relay-runtime.js covers workerd itself.
function relayHost(env) {
  const relays = new Map(), sockets = new Map();
  class TestRelay extends AccountRelay {
    accept(device) {
      const key = crypto.randomUUID();
      const socket = {
        attachment: null, ws: null, closed: false, pinged: 0,
        serializeAttachment(value) { this.attachment = structuredClone(value); },
        deserializeAttachment() { return this.attachment; },
        send(data) { this.ws.send(data); },
        close(code, reason) { this.closed = true; this.ws?.close(code, reason); },
      };
      this.ctx.acceptWebSocket(socket, [device.id]);
      socket.serializeAttachment({ ...device, folders: [], seen: Date.now() });
      sockets.set(key, { socket, relay: this });
      return new Response(null, { headers: { 'x-test-relay': key } });
    }
  }
  const context = () => ({
    sockets: [],
    storage: (() => {
      const values = new Map();
      return {
        async get(key) { return structuredClone(values.get(key)); },
        async put(key, value) { values.set(key, structuredClone(value)); },
        async delete(key) { return values.delete(key); },
        async list({ prefix = '' } = {}) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
      };
    })(),
    acceptWebSocket(socket, tags) { socket.tags = tags; this.sockets.push(socket); },
    getWebSockets(tag) { return this.sockets.filter(s => !s.closed && (!tag || s.tags.includes(tag))); },
    getWebSocketAutoResponseTimestamp(socket) { return socket.pinged ? new Date(socket.pinged) : null; },
  });
  const namespace = { idFromName: name => name, get: id => ({ fetch: request => { if (!relays.has(id)) relays.set(id, new TestRelay(context(), env())); return relays.get(id).fetch(request); } }) };
  const websocket = {
    open(ws) { sockets.get(ws.data.key).socket.ws = ws; },
    async message(ws, data) {
      const { socket, relay } = sockets.get(ws.data.key);
      if (data === 'ping') { socket.pinged = Date.now(); ws.send('pong'); return; }
      await relay.webSocketMessage(socket, String(data));
    },
    close(ws) { sockets.get(ws.data.key).socket.closed = true; },
  };
  return { namespace, websocket };
}

/**
 * A signed-in engine with web prompts on, one project chat synced, and the relay connected.
 * `script` drives the fake agent turn by turn within that chat.
 */
async function connectedDevice({ fakeDelayMs = 150, script = null } = {}) {
  let web;
  const host = relayHost(() => web.env);
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, websocket: host.websocket,
    async fetch(request, bun) {
      const response = await web.app.fetch(request);
      const key = response.headers.get('x-test-relay');
      if (key && bun.upgrade(request, /** @type {any} */ ({ data: { key } }))) return undefined;
      return response;
    },
  });
  web = fixture({ ACCESS_ORIGIN: server.url.origin, ENVIRONMENT: 'development', ACCESS_RELAY: host.namespace });
  const home = tempHome();
  const env = { JOLO_CREDENTIALS: 'session', JOLO_ACCOUNT_ORIGIN: server.url.origin };
  if (script) { const file = path.join(home, 'script.json'); writeFileSync(file, JSON.stringify(script)); env.JOLO_FAKE_SCRIPT = file; }
  const engine = await startEngine({ home, env, idleMs: 60_000, fakeDelayMs });
  const desktop = await engine.connect({ clientKind: 'desktop' });
  const cleanup = async () => { await desktop?.close?.(); await engine?.stop?.(); server.stop(true); removeHome(home); };
  try {
    const { session } = await openSession(desktop, home);
    const { run } = await desktop.call('run.start', { sessionId: session.id, requestId: crypto.randomUUID(), prompt: 'First local turn' });
    await waitFor(async () => (await desktop.call('run.snapshot', { runId: run.id })).run.state === 'completed', { timeoutMs: 15_000 });

    const pending = await desktop.call('account.login', { remote: true });
    await web.login();
    const csrf = web.sqlite.query('SELECT csrf FROM sessions').get().csrf;
    const post = (pathname, body) => web.send(pathname, { method: 'POST', headers: { origin: server.url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...body }) });
    expect((await post('/device/approve', { user_code: pending.pending.userCode, decision: 'approved' })).status).toBe(200);
    web.advance(5000);
    await waitFor(async () => (await desktop.call('account.status', {})).state === 'signed_in', { timeoutMs: 15_000, label: 'sign-in' });
    const status = await desktop.call('account.status', {});
    expect(status.device.scopes).toEqual(['account:read', 'chats:sync', 'prompts:run']);
    expect(status.remote.enabled).toBe(true);
    expect(status.remote.approvals).toBe(false);
    await desktop.call('account.sync', { enabled: true });
    const chat = await waitFor(() => web.sqlite.query('SELECT id, folder_id, project_id FROM synced_chats').get(), { timeoutMs: 15_000, label: 'chat sync' });
    await waitFor(async () => (await desktop.call('account.status', {})).remote.connected, { timeoutMs: 15_000, label: 'relay connection' });
    // The composer appears once the device has said it holds this chat's folder.
    const page = await waitFor(async () => { const html = await (await web.send(`/chats/${chat.id}`)).text(); return html.includes('prompt-composer') && html; }, { timeoutMs: 15_000, label: 'composer' });
    const target = /name="target" value="([^"]+)"/.exec(page)[1];
    return { web, engine, desktop, session, post, chat, target, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

test('a prompt typed on the web continues a synced chat on the online device, starts new chats in a folder, and stops on revocation', async () => {
  const { web, desktop, post, chat, target, cleanup } = await connectedDevice();
  try {
    const sent = await post(`/chats/${chat.id}/prompt`, { text: 'Continue from the web', target });
    expect(sent.headers.get('location')).toBe(`/chats/${chat.id}#continue`);
    const busy = await post(`/chats/${chat.id}/prompt`, { text: 'A second prompt', target });
    expect(busy.headers.get('location')).toContain('prompt_error=busy');
    const finished = await waitFor(() => web.sqlite.query("SELECT * FROM remote_prompts WHERE status NOT IN ('pending','delivered','accepted','running')").get(), { timeoutMs: 30_000, label: 'web prompt finished' });
    expect(finished.status).toBe('completed');
    const synced = JSON.parse(web.sqlite.query('SELECT content FROM synced_chats WHERE id=?').get(chat.id).content);
    const asked = synced.messages.findIndex(m => m.role === 'user' && m.text === 'Continue from the web');
    expect(asked).toBeGreaterThan(0);
    expect(synced.messages[asked + 1]?.role).toBe('assistant');
    expect((await desktop.call('session.list', { limit: 10 })).sessions).toHaveLength(1);

    // Cancelling on the web stops the run on the device. A long prompt in non-Latin text, many
    // times the size of an ordinary form once encoded, arrives whole.
    const long = `Stop me ${'é'.repeat(12_000)}`;
    expect((await post(`/chats/${chat.id}/prompt`, { text: long, target })).headers.get('location')).toBe(`/chats/${chat.id}#continue`);
    const stopping = await waitFor(() => web.sqlite.query("SELECT id FROM remote_prompts WHERE text=? AND status='running'").get(long), { timeoutMs: 15_000, label: 'running prompt' });
    expect((await post(`/prompts/${stopping.id}/cancel`, {})).headers.get('location')).toBe(`/chats/${chat.id}#continue`);
    await waitFor(() => web.sqlite.query("SELECT 1 FROM remote_prompts WHERE id=? AND status='cancelled'").get(stopping.id), { timeoutMs: 15_000, label: 'cancelled prompt' });

    // A new chat in a folder this device has.
    const project = await (await web.send(`/chats?project=${chat.project_id}`)).text();
    expect(project).toContain('Start a chat');
    const started = await post('/prompts', { text: 'Start something new', target: `${target}:${chat.folder_id}` });
    const promptPath = started.headers.get('location');
    expect(promptPath).toMatch(/^\/prompts\/[a-f0-9-]{36}$/);
    const created = await waitFor(() => web.sqlite.query("SELECT * FROM remote_prompts WHERE id=? AND status='completed'").get(promptPath.split('/')[2]), { timeoutMs: 30_000, label: 'new chat prompt' });
    expect(created.result_chat_id).toMatch(/^[a-f0-9-]{36}$/);
    expect((await web.send(promptPath)).headers.get('location')).toBe(`/chats/${created.result_chat_id}`);
    expect(web.sqlite.query('SELECT title FROM synced_chats WHERE id=?').get(created.result_chat_id).title).toBe('Start something new');

    // A folder the device never reported is refused before anything is sent.
    const refused = await post('/prompts', { text: 'Elsewhere', target: `${target}:${crypto.randomUUID()}` });
    expect(refused.headers.get('location')).toContain('prompt_error=folder');

    // Revoking the device closes its connection; the web no longer offers it.
    expect((await post('/devices/revoke', { device_id: target })).status).toBe(303);
    await waitFor(async () => (await desktop.call('account.status', {})).remote?.connected === false, { timeoutMs: 10_000, label: 'revocation' });
    expect(await (await web.send(`/chats/${chat.id}`)).text()).not.toContain('prompt-composer');
  } finally { await cleanup(); }
}, 120_000);

test('the web shows the reply as it is written and answers permission requests only when the device allows it', async () => {
  const script = [
    { text: ['Ready.\n'] },
    { text: ['Checking ', 'the ', 'workspace ', 'first.\n'], toolCalls: [{ name: 'run_command', arguments: { argv: ['echo', 'approved from the web'] } }] },
    { text: ['Ran it.\n'] },
    { toolCalls: [{ name: 'run_command', arguments: { argv: ['echo', 'not this one'] } }] },
    { text: ['Understood.\n'] },
    { toolCalls: [{ name: 'run_command', arguments: { argv: ['echo', 'x'.repeat(3000), 'y'.repeat(3000)] } }] },
  ];
  const { web, engine, desktop, session, post, chat, target, cleanup } = await connectedDevice({ script });
  const prompt = text => web.sqlite.query('SELECT * FROM remote_prompts WHERE text=?').get(text);
  try {
    await post(`/chats/${chat.id}/prompt`, { text: 'Run the check', target });
    const waiting = await waitFor(() => { const row = prompt('Run the check'); return row?.status === 'awaiting_permission' && row.permission && row; }, { timeoutMs: 20_000, label: 'permission request' });
    const request = JSON.parse(waiting.permission);
    expect(request).toMatchObject({ tool: 'run_command', command: "echo 'approved from the web'".replace(/'/g, '"') });
    // The reply so far is readable while the run waits.
    const live = await (await web.send(`/prompts/${waiting.id}/live`)).json();
    expect(live.text).toContain('Checking the workspace first.');
    // The page reloads when one request replaces another, so it never answers a stale one.
    expect(live.permission).toBe(request.id);
    // Approvals from the web are off: the page says to answer on the device, and an answer is ignored.
    let page = await (await web.send(`/chats/${chat.id}`)).text();
    expect(page).toContain('Approve from the web'); expect(page).not.toContain('Allow once');
    await post(`/prompts/${waiting.id}/permission`, { permission: request.id, decision: 'allow_once' });
    await Bun.sleep(1500);
    expect(prompt('Run the check').status).toBe('awaiting_permission');
    // Only allow_once and deny are accepted, even for a device that allows answers from the web.
    await desktop.call('account.remote', { approvals: true });
    page = await waitFor(async () => { const html = await (await web.send(`/chats/${chat.id}`)).text(); return html.includes('Allow once') && html; }, { timeoutMs: 15_000, label: 'approval buttons' });
    expect(page).toContain(request.id);
    await post(`/prompts/${waiting.id}/permission`, { permission: request.id, decision: 'allow_project' });
    await Bun.sleep(500);
    expect(prompt('Run the check').status).toBe('awaiting_permission');
    await post(`/prompts/${waiting.id}/permission`, { permission: request.id, decision: 'allow_once' });
    await waitFor(() => prompt('Run the check').status === 'completed', { timeoutMs: 20_000, label: 'approved run' });
    expect(prompt('Run the check').permission).toBeNull();
    expect((await (await web.send(`/prompts/${waiting.id}/live`)).json()).text).toBeNull();

    await post(`/chats/${chat.id}/prompt`, { text: 'Try another', target });
    const second = await waitFor(() => { const row = prompt('Try another'); return row?.status === 'awaiting_permission' && row.permission && row; }, { timeoutMs: 20_000, label: 'second request' });
    await post(`/prompts/${second.id}/permission`, { permission: JSON.parse(second.permission).id, decision: 'deny' });
    // Declining stops the run on the device, as it does locally; the next prompt continues the chat.
    await waitFor(() => prompt('Try another').status === 'failed', { timeoutMs: 20_000, label: 'declined run' });
    expect(prompt('Try another').error).toContain('run_command was declined');
    await post(`/chats/${chat.id}/prompt`, { text: 'Then explain', target });
    await waitFor(() => prompt('Then explain')?.status === 'completed', { timeoutMs: 20_000, label: 'prompt after decline' });
    const synced = JSON.parse(web.sqlite.query('SELECT content FROM synced_chats WHERE id=?').get(chat.id).content);
    expect(synced.messages.map(m => m.text).join('\n')).toContain('Ran it.');
    expect(synced.messages.at(-2)).toEqual({ role: 'user', text: 'Then explain' });
    expect(synced.messages.at(-1).role).toBe('assistant');
    // The local transcript marks what came from the web.
    const runs = (await desktop.call('session.page', { sessionId: session.id, limit: 50 })).runs;
    expect(runs.filter(run => run.requestId.startsWith('web_'))).toHaveLength(3);

    // A request too long to show whole is answered on the device only, even with approvals on.
    await post(`/chats/${chat.id}/prompt`, { text: 'Print a lot', target });
    const long = await waitFor(() => { const row = prompt('Print a lot'); return row?.status === 'awaiting_permission' && row.permission && row; }, { timeoutMs: 20_000, label: 'long request' });
    expect(JSON.parse(long.permission).complete).toBe(false);
    page = await (await web.send(`/chats/${chat.id}`)).text();
    expect(page).toContain('too long to review here'); expect(page).not.toContain('Allow once');
    await post(`/prompts/${long.id}/permission`, { permission: JSON.parse(long.permission).id, decision: 'allow_once' });
    await Bun.sleep(1500);
    expect(prompt('Print a lot').status).toBe('awaiting_permission');

    // With the device gone, cancelling ends the prompt on the web and says the run stops later.
    await desktop.close(); await engine.stop();
    await waitFor(async () => (await post(`/prompts/${long.id}/cancel`, {})) && prompt('Print a lot').status === 'cancelled', { timeoutMs: 15_000, label: 'offline cancel' });
    expect(prompt('Print a lot').error).toContain('is offline; the run stops when it reconnects');
  } finally { await cleanup(); }
}, 120_000);
