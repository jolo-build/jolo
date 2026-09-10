// Wire framing: 4-byte unsigned big-endian length followed by UTF-8 JSON.
// Runtime-neutral: works in Bun and in Electron's Node runtime.

export const FRAME_HEADER_BYTES = 4;
export const FRAME_MAX_BYTES = 256 * 1024;
export const CONNECTION_BUFFER_MAX_BYTES = 2 * FRAME_MAX_BYTES;

export class FramingError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = "FramingError";
    this.code = code;
  }
}

/**
 * Encode one JSON message as a length-prefixed frame.
 * @param {unknown} message
 * @param {{ maxBytes?: number }} [options]
 * @returns {Buffer}
 */
export function encodeFrame(message, options = {}) {
  const maxBytes = options.maxBytes ?? FRAME_MAX_BYTES;
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0) throw new FramingError("empty frame", "invalid_frame");
  if (body.length > maxBytes) throw new FramingError(`frame of ${body.length} bytes exceeds ${maxBytes}`, "limit_exceeded");
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Incremental decoder. Rejects oversized frames before allocating their payload and bounds the
 * aggregate buffered bytes per connection. Handles split and coalesced reads.
 * @param {{ maxBytes?: number, maxBuffered?: number, onMessage: (message: any) => void, onError: (error: FramingError) => void }} options
 * @returns {(chunk: Buffer) => void}
 */
export function createFrameDecoder(options) {
  const maxBytes = options.maxBytes ?? FRAME_MAX_BYTES;
  const maxBuffered = options.maxBuffered ?? CONNECTION_BUFFER_MAX_BYTES;
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  let headerBytes = 0, payload = null, payloadBytes = 0, failed = false;
  const fail = (message, code) => {
    failed = true;
    payload = null;
    options.onError(new FramingError(message, code));
  };
  return chunk => {
    if (failed || chunk.length === 0) return;
    if (headerBytes + payloadBytes + chunk.length > maxBuffered) return fail(`connection buffer exceeds ${maxBuffered} bytes`, "limit_exceeded");
    let offset = 0;
    while (offset < chunk.length) {
      if (!payload) {
        const count = Math.min(FRAME_HEADER_BYTES - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        headerBytes += count; offset += count;
        if (headerBytes < FRAME_HEADER_BYTES) return;
        const length = header.readUInt32BE(0);
        if (length === 0 || length > maxBytes) return fail(`invalid frame length ${length}`, length === 0 ? "invalid_frame" : "limit_exceeded");
        payload = Buffer.allocUnsafe(length);
        payloadBytes = 0;
      }
      const count = Math.min(payload.length - payloadBytes, chunk.length - offset);
      chunk.copy(payload, payloadBytes, offset, offset + count);
      payloadBytes += count; offset += count;
      if (payloadBytes < payload.length) continue;
      let message;
      try { message = JSON.parse(payload.toString("utf8")); }
      catch { return fail("frame is not valid JSON", "invalid_frame"); }
      payload = null; payloadBytes = 0; headerBytes = 0;
      options.onMessage(message);
      if (failed) return;
    }
  };
}
