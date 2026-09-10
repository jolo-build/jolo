import { isInteractive } from "./authorization.js";
// Unix-socket JSON-RPC server: framing, authentication, dispatch, subscriptions, bounded queues (§11).
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import {
  encodeFrame, createFrameDecoder, parseEnvelope, parseParams, parseResult, parseEvent, toRpcError, ProtocolError,
  PROTOCOL_VERSION, SCHEMA_VERSION, METHOD_NAMES, FRAME_MAX_BYTES, CONNECTION_BUFFER_MAX_BYTES, LIMITS, compareSeq,
} from "@jolo/protocol";

const HANDSHAKE_DEADLINE_MS = 5_000;
const OUTBOUND_MAX_BYTES = 512 * 1024;
const MAX_SCOPED_CLIENTS = 8;
const CONTROL_KINDS = new Set(["control"]);

function tokenMatches(expected, supplied) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(supplied ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {{ token: string, bootId: string, build: string, storage: any, previews: import("node:events").EventEmitter, lifetime: any, log: any, handlers: Record<string, (params: any, conn: any) => any> }} options
 */
export function createRpcServer(options) {
  const { token, bootId, build, storage, previews, lifetime, log, handlers } = options;
  const connections = new Set();
  let closing = false;
  const offRevoke = options.capabilityTokens?.onRevoke(token => { for (const conn of connections) if (conn.capabilityToken === token) conn.socket.destroy(); });

  const send = (conn, message, onWritten = () => {}) => {
    if (conn.closed || conn.socket.destroyed) return false;
    let frame;
    try {
      frame = encodeFrame(message);
    } catch (error) {
      log.warn("dropping oversized outbound frame", { code: error.code });
      return false;
    }
    conn.pendingBytes += frame.length;
    if (conn.pendingBytes > OUTBOUND_MAX_BYTES) {
      log.warn("client is not draining; disconnecting", { kind: conn.kind, pendingBytes: conn.pendingBytes });
      conn.closed = true;
      conn.socket.destroy();
      return false;
    }
    conn.socket.write(frame, (error) => { conn.pendingBytes -= frame.length; onWritten(error); });
    return true;
  };

  const respond = (conn, id, result) => {
    const message = { jsonrpc: "2.0", id, result };
    try { encodeFrame(message); }
    catch { return fail(conn, id, new ProtocolError("limit_exceeded", "response exceeds frame limit; request a smaller page or range")); }
    return send(conn, message);
  };
  const fail = (conn, id, error) => {
    if (!(error instanceof ProtocolError)) log.error("request failed", { error: String(error?.stack ?? error) });
    return send(conn, { jsonrpc: "2.0", id, error: toRpcError(error) });
  };

  const authenticatedCount = (control, scoped = false) => [...connections].filter((c) => c.authenticated && Boolean(c.capability) === scoped && CONTROL_KINDS.has(c.kind) === control).length;

  const handleHello = (conn, params) => {
    if (conn.authenticated) throw new ProtocolError("conflict", "already authenticated");
    const owner = tokenMatches(token, params.token);
    const capability = owner ? null : options.capabilityTokens?.lookup(params.token);
    if (!owner && !capability) throw new ProtocolError("unauthenticated", "invalid token");
    conn.capabilityToken = capability ? params.token : null;
    conn.capability = capability;

    if (params.protocol.major !== PROTOCOL_VERSION.major || params.protocol.minor > PROTOCOL_VERSION.minor) {
      throw new ProtocolError("version_mismatch", `engine protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}, client ${params.protocol.major}.${params.protocol.minor}`, { engine: PROTOCOL_VERSION });
    }
    const control = !capability && CONTROL_KINDS.has(params.clientKind);
    const limit = capability ? MAX_SCOPED_CLIENTS : control ? LIMITS.maxControlClients : LIMITS.maxClients;
    if (authenticatedCount(control, Boolean(capability)) >= limit) {
      throw new ProtocolError("limit_exceeded", "client limit reached; accepted work continues", { limit });
    }
    conn.authenticated = true;
    if (!capability) lifetime.clientConnected();
    conn.kind = capability ? "headless" : params.clientKind;
    conn.build = params.build;
    clearTimeout(conn.handshakeTimer);
    return {
      protocol: PROTOCOL_VERSION,
      schemaVersion: SCHEMA_VERSION,
      build,
      engineBootId: bootId,
      eventStreamId: storage.eventStreamId,
      supportedMethods: capability ? ["hello", ...capability.methods] : METHOD_NAMES,
      frameLimits: { maxFrameBytes: FRAME_MAX_BYTES, maxBufferedBytes: CONNECTION_BUFFER_MAX_BYTES },
    };
  };

  const sendReplay = (conn, event) => new Promise((resolve, reject) => {
    const gone = () => { cleanup(); reject(new ProtocolError("unavailable", "subscription connection closed")); };
    const timer = setTimeout(() => { conn.socket.destroy(); gone(); }, 5000);
    const cleanup = () => { clearTimeout(timer); conn.socket.off("close", gone); };
    conn.socket.once("close", gone);
    if (!send(conn, { jsonrpc: "2.0", method: "event", params: event }, error => {
      cleanup(); error ? reject(error) : resolve();
    })) gone();
  });

  const handleSubscribe = async (conn, params) => {
    // A connection has one subscription. Replacing it requires a new connection so
    // old in-flight notifications cannot be mistaken for replay of the new scope.
    if (conn.subscription) throw new ProtocolError("conflict", "this connection is already subscribed; use a new connection to change scope");
    const minRetained = storage.minRetainedSeq();
    const highWater = storage.maxSeq();
    if (compareSeq(params.after, highWater) > 0 || (minRetained !== "0" && compareSeq(params.after, String(BigInt(minRetained) - 1n)) < 0)) {
      throw new ProtocolError("resync_required", "cursor is outside retained history", { cursor: highWater });
    }
    const sub = { sessionId: params.sessionId ?? null, lastSeq: params.after, replaying: true, live: [], liveBytes: 0 };
    conn.subscription = sub;
    let cursor = params.after;
    let replayed = 0;
    try {
      for (;;) {
        if (conn.closed || conn.socket.destroyed) throw new ProtocolError("unavailable", "subscription connection closed");
        const oldest = storage.minRetainedSeq();
        if (oldest !== "0" && compareSeq(cursor, String(BigInt(oldest) - 1n)) < 0) throw new ProtocolError("resync_required", "history expired during replay", { cursor: storage.maxSeq() });
        const page = storage.listEvents({ after: cursor, sessionId: params.sessionId, limit: LIMITS.eventPageSize }).filter(event => compareSeq(event.eventSeq, highWater) <= 0);
        for (const event of page) {
          await sendReplay(conn, event);
          sub.lastSeq = cursor = event.eventSeq;
          replayed++;
        }
        if (page.length < LIMITS.eventPageSize || compareSeq(cursor, highWater) >= 0) break;
      }
      while (sub.live.length) {
        const event = sub.live.shift();
        sub.liveBytes -= Buffer.byteLength(JSON.stringify(event));
        if (compareSeq(event.eventSeq, sub.lastSeq) <= 0) continue;
        await sendReplay(conn, event);
        sub.lastSeq = event.eventSeq;
      }
      sub.replaying = false;
      return { cursor: sub.lastSeq, replayed };
    } catch (error) {
      conn.subscription = null;
      throw error;
    }
  };

  const dispatch = async (conn, message) => {
    const { id, method } = message;
    try {
      if (method !== "hello" && !conn.authenticated) throw new ProtocolError("unauthenticated", "authenticate first");
      const checked = parseParams(method, message.params);
      if (!checked.ok) throw checked.error;
      if (conn.capabilityToken) {
        const capability = options.capabilityTokens?.lookup(conn.capabilityToken);
        if (!capability || !capability.methods.includes(method) || checked.value.workspaceId !== capability.workspaceId) {
          throw new ProtocolError("permission_denied", "credential does not permit this operation");
        }
      }
      let result;
      if (method === "hello") result = handleHello(conn, checked.value);
      else if (!conn.authenticated) throw new ProtocolError("unauthenticated", "authenticate first");
      else if (method === "events.subscribe") result = await handleSubscribe(conn, checked.value);
      else if (handlers[method]) result = await handlers[method](checked.value, conn);
      else throw new ProtocolError("unknown_method", `unknown method ${method}`);
      const validated = parseResult(method, result);
      if (!validated.ok) throw validated.error;
      respond(conn, id, validated.value);
    } catch (error) {
      fail(conn, id, error);
    }
  };

  const onEvent = (event) => {
    const validated = parseEvent(event);
    if (!validated.ok) {
      log.error("invalid durable event", { type: event.type, error: validated.error.message });
      for (const conn of connections) if (conn.subscription) conn.socket.destroy();
      return;
    }
    for (const conn of connections) {
      const sub = conn.subscription;
      if (!sub) continue;
      if (sub.sessionId && sub.sessionId !== event.sessionId) continue;
      if (compareSeq(event.eventSeq, sub.lastSeq) <= 0) continue;
      if (sub.replaying) {
        sub.liveBytes += Buffer.byteLength(JSON.stringify(event));
        if (sub.liveBytes > OUTBOUND_MAX_BYTES) { conn.closed = true; conn.socket.destroy(); continue; }
        sub.live.push(event);
      } else if (send(conn, { jsonrpc: "2.0", method: "event", params: event })) sub.lastSeq = event.eventSeq;
    }
  };

  const onPreview = (preview) => {
    for (const conn of connections) {
      const sub = conn.subscription;
      if (!sub || (sub.sessionId && sub.sessionId !== preview.sessionId)) continue;
      send(conn, { jsonrpc: "2.0", method: "preview", params: preview });
    }
  };

  storage.events.on("event", onEvent);
  previews.on("preview", onPreview);

  const server = net.createServer((socket) => {
    if (closing || connections.size >= LIMITS.maxClients + LIMITS.maxControlClients + MAX_SCOPED_CLIENTS + 8) { socket.destroy(); return; }
    const conn = { socket, authenticated: false, kind: null, build: null, subscription: null, pendingBytes: 0, closed: false, handshakeTimer: null, closeHooks: new Set(), notify: (method, params) => send(conn, { jsonrpc: "2.0", method, params }) };
    connections.add(conn);
    conn.inFlight = 0;
    conn.handshakeTimer = setTimeout(() => { if (!conn.authenticated) socket.destroy(); }, HANDSHAKE_DEADLINE_MS);
    const decode = createFrameDecoder({
      onMessage: (raw) => {
        const envelope = parseEnvelope(raw);
        if (!envelope.ok) { send(conn, { jsonrpc: "2.0", id: "0", error: toRpcError(envelope.error) }); socket.destroy(); return; }
        const message = envelope.value;
        if (!("id" in message) || !("method" in message)) return; // clients do not send responses or notifications yet
        if (conn.inFlight >= 32) { fail(conn, message.id, new ProtocolError("limit_exceeded", "too many pending requests")); return; }
        conn.inFlight++;
        void dispatch(conn, message).finally(() => { conn.inFlight--; });
      },
      onError: (error) => {
        log.warn("closing connection on framing error", { code: error.code });
        try { send(conn, { jsonrpc: "2.0", id: "0", error: toRpcError(error) }); } catch { /* ignore */ }
        socket.destroy();
      },
    });
    socket.on("data", decode);
    socket.on("error", () => {});
    socket.on("end", () => socket.destroy()); // the protocol never half-closes: a peer FIN ends the connection now, not when the runtime decides
    socket.on("close", () => {
      conn.closed = true;
      clearTimeout(conn.handshakeTimer);
      connections.delete(conn);
      if (conn.authenticated && !conn.capability) lifetime.clientDisconnected();
      for (const hook of conn.closeHooks) { try { hook(); } catch (error) { log.warn("close hook failed", { error: String(error?.message ?? error) }); } }
    });
  });

  return {
    listen(socketPath) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.off("error", reject); resolve(); });
      });
    },
    get clientCount() {
      return [...connections].filter((c) => c.authenticated).length;
    },
    /** Clients able to submit a human decision (§10.1): desktop and TUI; tests count as interactive. */
    get interactiveClientCount() {
      return [...connections].filter((c) => c.authenticated && isInteractive(c)).length;
    },
    close() {
      offRevoke?.();
      closing = true;
      storage.events.off("event", onEvent);
      previews.off("preview", onPreview);
      for (const conn of connections) conn.socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
