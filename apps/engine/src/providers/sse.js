// Incremental server-sent-events parser with bounded event size.
const EVENT_MAX_BYTES = 1024 * 1024;

export function createSseParser(onEvent, { maxEventBytes = EVENT_MAX_BYTES } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = null;
  let data = [];
  let dataBytes = 0;
  const dispatch = () => {
    if (data.length === 0) { eventName = null; return; }
    const payload = data.join("\n");
    data = [];
    dataBytes = 0;
    const name = eventName;
    eventName = null;
    if (payload === "[DONE]") { onEvent({ event: "done", data: null }); return; }
    let parsed;
    try { parsed = JSON.parse(payload); } catch { onEvent({ event: "parse_error", data: null }); return; }
    onEvent({ event: name ?? parsed?.type ?? "message", data: parsed });
  };
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") { dispatch(); continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") eventName = value;
        else if (field === "data") {
          dataBytes += value.length;
          if (dataBytes > maxEventBytes) throw Object.assign(new Error("SSE event exceeds size limit"), { code: "limit_exceeded" });
          data.push(value);
        }
      }
      if (buffer.length > maxEventBytes) throw Object.assign(new Error("SSE line exceeds size limit"), { code: "limit_exceeded" });
    },
    end() {
      if (buffer.length) { this.push("\n"); buffer = ""; }
      dispatch();
    },
  };
}
