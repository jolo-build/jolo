import { describe, expect, test } from "bun:test";
import { createSseParser } from "../src/providers/sse.js";

describe("sse parser", () => {
  test("handles split chunks, multi-line data, comments, and [DONE]", () => {
    const events = [];
    const parser = createSseParser((e) => events.push(e));
    const stream = "event: response.output_text.delta\ndata: {\"delta\":\"he\"}\n\n: keepalive\n\ndata: {\"a\":1,\ndata: \"b\":2}\n\ndata: [DONE]\n\n";
    for (let i = 0; i < stream.length; i += 5) parser.push(stream.slice(i, i + 5));
    parser.end();
    expect(events).toEqual([
      { event: "response.output_text.delta", data: { delta: "he" } },
      { event: "message", data: { a: 1, b: 2 } },
      { event: "done", data: null },
    ]);
  });
  test("bounds event size", () => {
    const parser = createSseParser(() => {}, { maxEventBytes: 64 });
    expect(() => parser.push(`data: ${"x".repeat(100)}\n\n`)).toThrow(/size limit/);
  });
});
