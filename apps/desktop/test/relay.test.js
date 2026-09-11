import { describe, expect, test } from "bun:test";
import { createRelay } from "../src/main/relay.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const event = (seq) => ({ engineBootId: "b", eventSeq: String(seq), sessionId: "s", runId: "r", type: "run.state", payload: { state: "model", revision: seq }, at: "2026-09-07T00:00:00.000Z" });

describe("desktop relay credits", () => {
  test("stops sending after eight unacknowledged batches and resumes on ack", async () => {
    const sent = [];
    // `createRelay` destructures its options without a JSDoc type, so the checker reads `log` as
    // required even though the relay only ever calls `log?.warn`. This test leaves it out on
    // purpose: a relay with nowhere to log must still hold its credits.
    const relay = createRelay(/** @type {{ send: any, log: any }} */ ({ send: (batch) => sent.push(batch) }));
    for (let i = 1; i <= 12; i += 1) { relay.push("event", event(i)); await sleep(20); }
    expect(sent.length).toBe(8);
    expect(relay.stats.queued).toBe(4);
    relay.ack(sent[0].id);
    await sleep(30);
    expect(sent.length).toBe(9);
    expect(sent[8].items.map((i) => i.value.eventSeq)).toEqual(["9", "10", "11", "12"]);
  });

  test("drops previews while blocked and keeps durable events, then demands a resync on overflow", async () => {
    const sent = [];
    const relay = createRelay({ send: (batch) => sent.push(batch), log: { warn() {} } });
    for (let i = 1; i <= 8; i += 1) { relay.push("event", event(i)); await sleep(20); }
    relay.push("preview", { sessionId: "s", runId: "r", messageId: "m", byteOffset: 0, text: "x" });
    expect(relay.stats.queued).toBe(0);
    for (let i = 9; i < 9 + 2_100; i += 1) relay.push("event", event(i));
    expect(relay.stats.queued).toBeLessThanOrEqual(2_000);
    for (const batch of sent.splice(0)) relay.ack(batch.id);
    await sleep(60);
    expect(sent.some((batch) => batch.resyncRequired)).toBe(true);
    expect(sent[0].previewsDropped).toBe(1);
  });

  test("a resync with no queued events is delivered when the renderer returns credit", async () => {
    const sent = [];
    // Again without a logger; see the first test for why the option bag is asserted.
    const relay = createRelay(/** @type {{ send: any, log: any }} */ ({ send: batch => sent.push(batch) }));
    for (let i = 1; i <= 8; i++) { relay.push("event", event(i)); await sleep(20); }
    relay.resync();
    await sleep(30);
    expect(sent).toHaveLength(8);
    relay.ack(sent[0].id);
    await sleep(30);
    expect(sent).toHaveLength(9);
    expect(sent[8]).toMatchObject({ items: [], resyncRequired: true });
  });
});
