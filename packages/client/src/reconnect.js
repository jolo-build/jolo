// Reconnect policy shared by frontends. In-flight calls fail on disconnect; they
// are never replayed because a mutation may already have committed remotely.
export async function connectResumable({ open, onResync = () => {}, retryBaseMs = 100, retryMaxMs = 5000 }) {
  let current = null, connecting = null, stopped = false, retryTimer = null, failures = 0, fatal = null;
  let subscription = null, cursor = '0', streamId = null;
  const events = new Set(), previews = new Set(), closes = new Set(), notifications = new Map();
  const reconnects = new Set();
  const emit = (handlers, value) => { for (const fn of handlers ?? []) { try { Promise.resolve(fn(value)).catch(error => console.error("client listener failed", error)); } catch (error) { console.error('client listener failed', error); } } };
  const schedule = () => {
    if (stopped || fatal || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensure().catch(() => schedule());
    }, Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures++, 8)));
    retryTimer.unref?.();
  };
  const ensure = () => {
    if (fatal) return Promise.reject(fatal);
    if (stopped) return Promise.reject(Object.assign(new Error('client closed'), { code: 'unavailable' }));
    if (current && !current.closed && !connecting) return Promise.resolve(current);
    if (connecting) return connecting;
    connecting = (async () => {
      const client = await open();
      if (stopped) { await client.close(); throw new Error('client closed'); }
      current = client;
      client.onClose(error => { if (current !== client) return; current = null; emit(closes, error); schedule(); });
      client.onEvent(event => { cursor = event.eventSeq; emit(events, event); });
      client.onPreview(preview => emit(previews, preview));
      for (const method of notifications.keys()) client.onNotification(method, params => emit(notifications.get(method), params));
      const changed = streamId && client.hello.eventStreamId && streamId !== client.hello.eventStreamId;
      streamId = client.hello.eventStreamId ?? streamId;
      if (subscription) {
        const reset = async () => {
          const status = await client.call('engine.status', {});
          cursor = status.cursor;
          await onResync({ cursor, streamId });
        };
        if (changed) await reset();
        try { await client.subscribe({ ...subscription, after: cursor }); }
        catch (error) {
          if (error.code !== 'resync_required') throw error;
          await reset();
          await client.subscribe({ ...subscription, after: cursor });
        }
        emit(reconnects, client.hello);
      }
      failures = 0;
      return client;
    })().catch(async error => {
      if (['version_mismatch', 'unauthenticated', 'permission_denied'].includes(error.code)) { fatal = error; clearTimeout(retryTimer); retryTimer = null; emit(closes, error); }
      const failed = current; current = null; await failed?.close(); throw error;
    }).finally(() => { connecting = null; });
    return connecting;
  };
  await ensure();
  return {
    get hello() { return current?.hello; },
    get closed() { return stopped; },
    get connected() { return Boolean(current && !current.closed); },
    get lastSeq() { return cursor; },
    async call(method, params) { return (await ensure()).call(method, params); },
    async subscribe(params = {}, handlers = {}) {
      if (subscription) throw Object.assign(new Error('already subscribed'), { code: 'conflict' });
      if (handlers.onEvent) events.add(handlers.onEvent);
      if (handlers.onPreview) previews.add(handlers.onPreview);
      const client = await ensure();
      cursor = params.after ?? '0';
      try {
        const result = await client.subscribe(params);
        subscription = params;
        return result;
      } catch (error) {
        if (error.code !== "resync_required") throw error;
        const status = await client.call("engine.status", {});
        cursor = status.cursor;
        await onResync({ cursor, streamId });
        const result = await client.subscribe({ ...params, after: cursor });
        subscription = params;
        return result;
      }
    },
    onEvent(fn) { events.add(fn); return () => events.delete(fn); },
    onPreview(fn) { previews.add(fn); return () => previews.delete(fn); },
    onClose(fn) { closes.add(fn); return () => closes.delete(fn); },
    onReconnect(fn) { reconnects.add(fn); return () => reconnects.delete(fn); },
    onNotification(method, fn) {
      if (!notifications.has(method)) {
        notifications.set(method, new Set());
        current?.onNotification(method, params => emit(notifications.get(method), params));
      }
      notifications.get(method).add(fn);
      return () => notifications.get(method)?.delete(fn);
    },
    async close() { stopped = true; clearTimeout(retryTimer); const client = current; current = null; await client?.close(); },
  };
}
