// Hold live events until the snapshot is seeded so an older snapshot cannot rewind a running chat.
// Previews during loading are disposable: durable commits fill their text from artifacts.
export function sessionLoader({ client, sessionId, projection, onPage, onError, maxPending = 256 }) {
  let loading = true;
  let disposed = false;
  let overflow = false;
  let pending = [];
  return {
    async load() {
      try {
        let page;
        do {
          pending = []; overflow = false;
          page = await client.call("session.page", { sessionId });
          if (disposed) return;
        } while (overflow); // Refresh instead of retaining an unbounded event buffer.
        projection.seed(page);
        loading = false;
        for (const event of pending) projection.applyEvent(event); // The projection skips events covered by the cursor.
        pending = [];
        onPage(page);
      } catch (error) { if (!disposed) onError(error); }
    },
    event(event) {
      if (disposed) return;
      if (!loading) { projection.applyEvent(event); return; }
      if (pending.length < maxPending) pending.push(event);
      else overflow = true;
    },
    preview(preview) { if (!disposed && !loading) projection.applyPreview(preview); },
    dispose() { disposed = true; pending = []; },
  };
}
