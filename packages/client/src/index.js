// Node/Bun-compatible socket client. No Bun-only APIs.
import net from "node:net";
import { encodeFrame, createFrameDecoder, parseEnvelope, parseParams, parseResult, parseEvent, parsePreview, parseBrowserExecute, TerminalOutputSchema, TerminalStateSchema, compareSeq, PROTOCOL_VERSION, ProtocolError } from "@jolo/protocol";

/**
 * @param {{ socketPath: string, token: string, clientKind?: string, build?: string, requestTimeoutMs?: number, idPrefix?: string }} options
 */
export async function connect(options) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const idPrefix = options.idPrefix ?? options.clientKind ?? "c";
  const socket = net.createConnection(options.socketPath);
  socket.setNoDelay?.(true);
  const pending = new Map();
  const eventHandlers = new Set();
  const previewHandlers = new Set();
  const closeHandlers = new Set();
  const notificationHandlers = new Map(); // method -> Set<handler>
  let sequence = 0;
  let lastSeq = "0";
  let closed = false;
  let closeError = null;
  let subscribing = false, subscribed = false;

  const failAll = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  const finish = (error) => {
    if (closed) return;
    closed = true;
    closeError = error ?? null;
    failAll(error ?? Object.assign(new Error("connection closed"), { code: "unavailable" }));
    for (const handler of closeHandlers) handler(closeError);
  };

  const decode = createFrameDecoder({
    onMessage: (raw) => {
      const envelope = parseEnvelope(raw);
      if (!envelope.ok) return socket.destroy(envelope.error);
      const message = envelope.value;
      if ("method" in message && !("id" in message)) {
        if (message.method === "event") {
          const event = parseEvent(message.params);
          if (!event.ok) return socket.destroy(event.error);
          if (compareSeq(event.value.eventSeq, lastSeq) <= 0) return; // duplicate or replayed
          lastSeq = event.value.eventSeq;
          for (const handler of eventHandlers) handler(event.value);
        } else if (message.method === "preview") {
          const preview = parsePreview(message.params);
          if (!preview.ok) return socket.destroy(preview.error);
          for (const handler of previewHandlers) handler(preview.value);
        } else {
          const valid = message.method === "terminal.output" ? TerminalOutputSchema.safeParse(message.params).success
            : message.method === "terminal.state" ? TerminalStateSchema.safeParse(message.params).success
            : message.method === "browser.execute" ? parseBrowserExecute(message.params).ok : true;
          if (!valid) return socket.destroy(new ProtocolError("invalid_frame", `invalid ${message.method} notification`));
          for (const handler of notificationHandlers.get(message.method) ?? []) handler(message.params);
        }
        return;
      }
      const p = pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(message.id);
      if ("error" in message) {
        const code = message.error.data?.code ?? "internal";
        p.reject(new ProtocolError(code, message.error.message, message.error.data?.details));
      } else {
        // A frame that carries neither `error` nor a pending-request method is a response by
        // elimination: it matched an id this client is waiting on.
        const response = /** @type {{ result: unknown }} */ (/** @type {unknown} */ (message));
        const checked = parseResult(p.method, response.result);
        if (!checked.ok) p.reject(checked.error);
        else p.resolve(checked.value);
      }
    },
    onError: (error) => socket.destroy(error),
  });

  socket.on("data", decode);
  // Socket failures arrive as Node errors carrying an errno code; anything without one is reported
  // as unavailable so callers see a single vocabulary.
  socket.on("error", (/** @type {Error & { code?: string }} */ error) => finish(Object.assign(error, { code: error.code ?? "unavailable" })));
  socket.on("close", () => finish(null));
  socket.on("end", () => { finish(null); socket.destroy(); });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const call = (method, params = {}) => {
    if (closed) return Promise.reject(Object.assign(new Error("connection closed"), { code: "unavailable" }));
    if (hello?.supportedMethods && !hello.supportedMethods.includes(method)) return Promise.reject(new ProtocolError("unknown_method", `engine does not support ${method}`));
    const checked = parseParams(method, params);
    if (!checked.ok) return Promise.reject(checked.error);
    return new Promise((resolve, reject) => {
      const id = `${idPrefix}:${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`timeout: ${method}`), { code: "unavailable" }));
      }, method === "agent.models" || method === "events.subscribe" ? Math.max(requestTimeoutMs, 65_000) : requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try {
        const frame = encodeFrame({ jsonrpc: "2.0", id, method, params: checked.value });
        if (hello?.frameLimits && frame.length - 4 > hello.frameLimits.maxFrameBytes) throw new ProtocolError("limit_exceeded", "request exceeds the engine frame limit");
        socket.write(frame);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  let hello;
  try {
    hello = await call("hello", { token: options.token, protocol: PROTOCOL_VERSION, build: options.build ?? "dev", clientKind: options.clientKind ?? "headless" });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  if (hello.protocol.major !== PROTOCOL_VERSION.major || hello.protocol.minor < PROTOCOL_VERSION.minor) {
    socket.destroy();
    throw new ProtocolError("version_mismatch", `engine protocol ${hello.protocol.major}.${hello.protocol.minor} is incompatible with client ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`);
  }

  return {
    hello,
    call,
    /** Register handlers, then subscribe from a cursor. Replayed events arrive as notifications. */
    async subscribe(params, handlers = {}) {
      if (subscribing || subscribed) throw new ProtocolError("conflict", "this connection is already subscribed");
      subscribing = true;
      if (handlers.onEvent) eventHandlers.add(handlers.onEvent);
      if (handlers.onPreview) previewHandlers.add(handlers.onPreview);
      lastSeq = params?.after ?? "0";
      try { const result = await call("events.subscribe", params ?? {}); subscribed = true; return result; }
      finally { subscribing = false; }
    },
    onEvent(handler) { eventHandlers.add(handler); return () => eventHandlers.delete(handler); },
    onPreview(handler) { previewHandlers.add(handler); return () => previewHandlers.delete(handler); },
    onClose(handler) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    /** Engine-initiated notifications other than events/previews (for example browser.execute to a host). */
    onNotification(method, handler) {
      if (!notificationHandlers.has(method)) notificationHandlers.set(method, new Set());
      notificationHandlers.get(method).add(handler);
      return () => notificationHandlers.get(method)?.delete(handler);
    },
    get lastSeq() { return lastSeq; },
    get closed() { return closed; },
    close() {
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        closeHandlers.add(() => resolve());
        socket.end();
        setTimeout(() => socket.destroy(), 500).unref?.();
      });
    },
  };
}

export { connectResumable } from "./reconnect.js";
