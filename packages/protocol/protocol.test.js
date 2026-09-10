import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeFrame, createFrameDecoder, FRAME_MAX_BYTES, parseEnvelope, parseParams, parseEvent, compareSeq, toRpcError, ProtocolError } from "./src/index.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/wire.json", import.meta.url), "utf8"));

describe("framing", () => {
  test("round-trips split and coalesced reads", () => {
    const messages = [{ a: 1 }, { b: "two" }, { c: [3] }];
    const frames = Buffer.concat(messages.map((m) => encodeFrame(m)));
    const seen = [];
    const decode = createFrameDecoder({ onMessage: (m) => seen.push(m), onError: (e) => { throw e; } });
    for (let i = 0; i < frames.length; i += 3) decode(frames.subarray(i, Math.min(i + 3, frames.length)));
    expect(seen).toEqual(messages);
    const seen2 = [];
    const decode2 = createFrameDecoder({ onMessage: (m) => seen2.push(m), onError: (e) => { throw e; } });
    decode2(frames);
    expect(seen2).toEqual(messages);
  });

  test("rejects oversized frames before allocating them", () => {
    const errors = [];
    const decode = createFrameDecoder({ onMessage: () => { throw new Error("must not deliver"); }, onError: (e) => errors.push(e) });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(FRAME_MAX_BYTES + 1, 0);
    decode(header);
    expect(errors[0]?.code).toBe("limit_exceeded");
    expect(() => encodeFrame({ text: "x".repeat(FRAME_MAX_BYTES) })).toThrow(/exceeds/);
  });

  test("rejects zero-length and malformed frames", () => {
    const errors = [];
    const decode = createFrameDecoder({ onMessage: () => {}, onError: (e) => errors.push(e) });
    decode(Buffer.from([0, 0, 0, 0]));
    expect(errors[0]?.code).toBe("invalid_frame");
    const bad = Buffer.from("{not json");
    const frame = Buffer.concat([Buffer.from([0, 0, 0, bad.length]), bad]);
    const errors2 = [];
    createFrameDecoder({ onMessage: () => {}, onError: (e) => errors2.push(e) })(frame);
    expect(errors2[0]?.code).toBe("invalid_frame");
  });

  test("bounds aggregate buffered bytes", () => {
    const errors = [];
    const decode = createFrameDecoder({ maxBuffered: 64, onMessage: () => {}, onError: (e) => errors.push(e) });
    decode(Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(100, 0x20)]));
    expect(errors[0]?.code).toBe("limit_exceeded");
  });
});

describe("schemas", () => {
  test("envelope fixtures", () => {
    for (const f of fixtures.envelopes) expect(parseEnvelope(f.value).ok, f.name).toBe(f.valid);
  });
  test("param fixtures", () => {
    for (const f of fixtures.params) expect(parseParams(f.method, f.value).ok, `${f.method} ${JSON.stringify(f.value)}`).toBe(f.valid);
  });
  test("event fixtures", () => {
    for (const f of fixtures.events) expect(parseEvent(f.value).ok).toBe(f.valid);
  });
  test("defaults are applied", () => {
    const parsed = parseParams("events.subscribe", {});
    expect(parsed.ok && parsed.value.after).toBe("0");
  });
  test("sequence comparison avoids precision loss", () => {
    expect(compareSeq("9007199254740993", "9007199254740992")).toBe(1);
  });
  test("rpc errors never leak internal messages", () => {
    const e = toRpcError(new Error("stack trace with secrets"));
    expect(e.data.code).toBe("internal");
    expect(e.message).toBe("internal error");
    expect(toRpcError(new ProtocolError("conflict", "revision moved")).message).toBe("revision moved");
  });
});
