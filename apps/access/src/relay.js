// One Durable Object per account holds the WebSocket each signed-in engine opens to receive
// prompts from the web. Engines dial out, so no device needs an inbound port. Sockets use the
// hibernation API: an idle connection costs nothing, and a `ping` is answered without waking.
const UUID = /^[a-f0-9-]{36}$/;
const FRESH_MS = 90_000;
const MESSAGE_BYTES = 128 * 1024;
const LIVE_CHARS = 16_000;
export const ACTIVE_PROMPT = ['pending', 'delivered', 'accepted', 'running', 'awaiting_permission'];
// Programs that share this file without the Workers types (tests, scripts) still type-check it.
const workerd = /** @type {any} */ (globalThis);
const REPORTED = ['accepted', 'running', 'awaiting_permission', 'completed', 'failed', 'cancelled', 'rejected'];
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;

/** The relay for one account, reached only through the Worker, which authenticates every caller. */
export function relayFor(env, accountId) {
  if (!env.ACCESS_RELAY) return null;
  const stub = env.ACCESS_RELAY.get(env.ACCESS_RELAY.idFromName(accountId));
  const call = async (path, body) => (await stub.fetch(new Request(`https://relay${path}`, { method: 'POST', body: JSON.stringify(body) }))).json();
  return {
    connect: device => stub.fetch(new Request('https://relay/connect', { headers: { Upgrade: 'websocket', 'X-Relay-Device': JSON.stringify(device) } })),
    online: async () => (await call('/online', {})).devices,
    send: async (deviceId, message) => (await call('/send', { deviceId, message })).sent,
    live: async id => (await call('/live', { id })).text,
    disconnect: deviceId => call('/disconnect', { deviceId }),
  };
}

/**
 * What a waiting run asks permission for: enough for a person to decide, bounded in size.
 * `complete` says the page shows all an approval would allow; nothing shortened goes unnoticed.
 */
function permissionRequest(value) {
  if (!value || typeof value.id !== 'string' || value.id.length > 128 || typeof value.tool !== 'string') return null;
  const fits = (field, max) => value[field] == null || (typeof value[field] === 'string' && value[field].length <= max);
  return { id: value.id, tool: value.tool.slice(0, 64), summary: text(value.summary, 500) ?? value.tool.slice(0, 64), command: text(value.command, 4000),
    complete: value.complete === true && value.tool.length <= 64 && fits('summary', 500) && fits('command', 4000) };
}

/** Apply one status report. A device can only move its own prompts, and only while they are active. */
export async function recordStatus(db, device, message, now = Date.now()) {
  if (!UUID.test(message.id ?? '') || !REPORTED.includes(message.status)) return false;
  const chatId = UUID.test(message.chatId ?? '') ? message.chatId : null;
  const permission = message.status === 'awaiting_permission' ? permissionRequest(message.permission) : null;
  const result = await db.prepare(`UPDATE remote_prompts SET status=?1, error=?2, result_chat_id=coalesce(?3,result_chat_id), permission=?4, updated_at=?5
    WHERE id=?6 AND account_id=?7 AND device_id=?8 AND status IN ('pending','delivered','accepted','running','awaiting_permission') RETURNING id`)
    .bind(message.status, text(message.error, 500), chatId, permission && JSON.stringify(permission), now, message.id, device.accountId, device.id).first();
  return Boolean(result);
}

export class AccountRelay {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    /** Prompts this device may stream text for; rebuilt from D1 after the object wakes. */
    this.owned = new Map();
    if (typeof workerd.WebSocketRequestResponsePair === 'function') ctx.setWebSocketAutoResponse(new workerd.WebSocketRequestResponsePair('ping', 'pong'));
  }
  /** The Worker has already checked the device token; this only binds the socket to that device. */
  accept(device) {
    const [client, server] = Object.values(new workerd.WebSocketPair());
    this.ctx.acceptWebSocket(server, [device.id]);
    server.serializeAttachment({ ...device, seen: Date.now() });
    return new Response(null, /** @type {any} */ ({ status: 101, webSocket: client }));
  }
  seen(socket) {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
    return Math.max(socket.deserializeAttachment()?.seen ?? 0, pinged);
  }
  socket(deviceId) {
    return this.ctx.getWebSockets(deviceId).filter(socket => Date.now() - this.seen(socket) < FRESH_MS).at(-1) ?? null;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/connect') {
      const device = JSON.parse(request.headers.get('X-Relay-Device'));
      // A reconnect replaces the previous socket, so one device never receives a prompt twice.
      for (const old of this.ctx.getWebSockets(device.id)) try { old.close(4000, 'Replaced by a newer connection.'); } catch { /* already closed */ }
      return this.accept({ id: device.id, name: device.name, accountId: device.accountId });
    }
    const body = await request.json();
    if (path === '/online') {
      const devices = new Map();
      for (const socket of this.ctx.getWebSockets()) {
        const device = socket.deserializeAttachment();
        if (!device || Date.now() - this.seen(socket) >= FRESH_MS) continue;
        // Socket attachments hold at most 16 KiB, too little for a long folder list, so what a
        // device reported lives in storage.
        const reported = await this.ctx.storage.get(`device:${device.id}`) ?? { folders: [], approvals: false };
        devices.set(device.id, { id: device.id, name: device.name, folders: reported.folders, approvals: reported.approvals });
      }
      return Response.json({ devices: [...devices.values()] });
    }
    if (path === '/send') {
      const socket = this.socket(body.deviceId);
      if (!socket) return Response.json({ sent: false });
      try { socket.send(JSON.stringify(body.message)); } catch { return Response.json({ sent: false }); }
      return Response.json({ sent: true });
    }
    if (path === '/live') return Response.json({ text: (await this.ctx.storage.get(`live:${body.id}`))?.text ?? null });
    if (path === '/disconnect') {
      for (const socket of this.ctx.getWebSockets(body.deviceId)) try { socket.close(4001, 'Device access was revoked.'); } catch { /* already closed */ }
      await this.ctx.storage.delete(`device:${body.deviceId}`);
      return Response.json({});
    }
    return new Response(null, { status: 404 });
  }
  async owns(device, id) {
    const key = `${device.id}:${id}`;
    if (!this.owned.has(key)) {
      const row = await this.env.ACCESS_DB.prepare(`SELECT 1 AS ok FROM remote_prompts WHERE id=?1 AND account_id=?2 AND device_id=?3 AND status IN ('pending','delivered','accepted','running','awaiting_permission')`).bind(id, device.accountId, device.id).first();
      this.owned.set(key, Boolean(row));
    }
    return this.owned.get(key);
  }
  async ended(device, id) {
    if (!UUID.test(id ?? '')) return false;
    const row = await this.env.ACCESS_DB.prepare('SELECT status FROM remote_prompts WHERE id=?1 AND account_id=?2 AND device_id=?3').bind(id, device.accountId, device.id).first();
    return Boolean(row) && !ACTIVE_PROMPT.includes(row.status);
  }
  async webSocketMessage(socket, data) {
    const device = socket.deserializeAttachment();
    if (typeof data !== 'string' || data.length > MESSAGE_BYTES) return socket.close(1009, 'Message too large.');
    let message;
    try { message = JSON.parse(data); } catch { return socket.close(1003, 'Invalid message.'); }
    device.seen = Date.now();
    socket.serializeAttachment(device);
    // The engine lists the synced folders it has a real checkout for, never paths, and whether it
    // accepts permission answers from the web.
    if (message?.type === 'hello' && Array.isArray(message.folders)) {
      await this.ctx.storage.put(`device:${device.id}`, { folders: message.folders.filter(id => UUID.test(id)).slice(0, 2000), approvals: message.approvals === true });
      // Text left by a device that stopped mid-run, never reaching a final status.
      for (const [key, value] of await this.ctx.storage.list({ prefix: 'live:' })) if (Date.now() - value.at > 86400_000) await this.ctx.storage.delete(key);
    }
    // The reply so far, for the page to show while the run works. Only the latest copy is kept,
    // and only until the prompt finishes; the synced chat is the lasting record.
    if (message?.type === 'live' && UUID.test(message.id ?? '') && typeof message.text === 'string' && await this.owns(device, message.id)) {
      await this.ctx.storage.put(`live:${message.id}`, { text: message.text.slice(-LIVE_CHARS), at: Date.now() });
    }
    if (message?.type === 'status') {
      if (await recordStatus(this.env.ACCESS_DB, device, message)) {
        if (!ACTIVE_PROMPT.includes(message.status)) {
          this.owned.delete(`${device.id}:${message.id}`);
          await this.ctx.storage.delete(`live:${message.id}`);
        }
      } else if (ACTIVE_PROMPT.includes(message.status) && await this.ended(device, message.id)) {
        // The web already ended this prompt (cancelled or expired while the device was away), so
        // the run the device still reports has no page waiting for it: stop it.
        try { socket.send(JSON.stringify({ type: 'cancel', id: message.id })); } catch { /* closing */ }
      }
    }
  }
  webSocketClose(socket, code) {
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
  }
}
