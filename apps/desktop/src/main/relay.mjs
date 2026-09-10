// Bounded relay between the engine socket and the renderer IPC hop.
// Credits return only after the renderer acknowledges a batch; a stalled renderer drops previews,
// buffers durable events up to a cap, and then requires a resync instead of unbounded queueing.

const MAX_OUTSTANDING_BATCHES = 8;
const MAX_OUTSTANDING_BYTES = 512 * 1024;
const MAX_BUFFERED_EVENTS = 2_000;
const FLUSH_INTERVAL_MS = 16;

export function createRelay({ send, log }) {
  let nextId = 1;
  const outstanding = new Map(); // batchId -> bytes
  let outstandingBytes = 0;
  let queue = []; // { kind, value, bytes }
  let previewsDropped = 0;
  let terminalDropped = false;
  let resyncRequired = false;
  let timer = null;

  const canSend = () => outstanding.size < MAX_OUTSTANDING_BATCHES && outstandingBytes < MAX_OUTSTANDING_BYTES;

  const flush = () => {
    timer = null;
    if ((!queue.length && !resyncRequired) || !canSend()) return;
    const items = [];
    let bytes = 0;
    while (queue.length && bytes < 64 * 1024 && items.length < 200) {
      const entry = queue.shift();
      items.push({ kind: entry.kind, value: entry.value });
      bytes += entry.bytes;
    }
    const id = nextId++;
    outstanding.set(id, bytes);
    outstandingBytes += bytes;
    send({ id, items, resyncRequired, previewsDropped, terminalDropped });
    resyncRequired = false;
    previewsDropped = 0;
    terminalDropped = false;
    if (queue.length && canSend()) schedule();
  };

  const schedule = () => { if (!timer) timer = setTimeout(flush, FLUSH_INTERVAL_MS); };

  return {
    push(kind, value) {
      const bytes = JSON.stringify(value).length;
      if (!canSend() && kind === "preview") { previewsDropped += 1; return; } // transient; commits will fill the gap
      if (!canSend() && kind === "terminal") { terminalDropped = true; return; } // the renderer re-attaches from a snapshot (§16.1)
      if (kind === "event" && queue.length >= MAX_BUFFERED_EVENTS) {
        // The renderer is not consuming; keep durable state in the engine and demand a resync later.
        queue = queue.filter((entry) => entry.kind !== "preview");
        if (queue.length >= MAX_BUFFERED_EVENTS) { queue = []; resyncRequired = true; log?.warn("relay buffer overflow; renderer must resync"); }
      }
      queue.push({ kind, value, bytes });
      schedule();
    },
    ack(id) {
      const bytes = outstanding.get(id);
      if (bytes === undefined) return;
      outstanding.delete(id);
      outstandingBytes -= bytes;
      if (queue.length || resyncRequired) schedule();
    },
    resync() { queue = []; resyncRequired = true; schedule(); },
    reset() {
      outstanding.clear();
      outstandingBytes = 0;
      queue = [];
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get stats() { return { outstanding: outstanding.size, outstandingBytes, queued: queue.length }; },
  };
}
