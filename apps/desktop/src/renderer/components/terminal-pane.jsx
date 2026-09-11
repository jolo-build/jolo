import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ensureFontLoaded, stackFor } from "../fonts.js";

const decodeBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Disposable xterm.js projection of an engine-owned terminal (§16.1). The engine keeps the authoritative screen. */
/** `attachTo` views a terminal the engine already owns; closing the view then leaves the process running. */
export function TerminalPane({ workspaceId, paneId, attachTo = null, onState }) {
  const host = useRef(null);
  const term = useRef(null);
  const fit = useRef(null);
  const terminalId = useRef(null);
  const lastSeq = useRef(0n);
  const [status, setStatus] = useState("opening…");

  useEffect(() => {
    let disposed = false;
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    const theme = () => appearance.matches ? { background: "#191a1c", foreground: "#ededee", cursor: "#ededee", selectionBackground: "#282f47" } : { background: "#fcfcfb", foreground: "#242629", cursor: "#292c30", selectionBackground: "#edf1ff" };
    const instance = new Terminal({ cursorBlink: true, fontSize: 12.5, fontFamily: stackFor("terminal"), scrollback: 2000, theme: theme() });
    const updateTheme = () => { instance.options.theme = theme(); };
    appearance.addEventListener("change", updateTheme);
    const fitter = new FitAddon();
    instance.loadAddon(fitter);
    term.current = instance;
    fit.current = fitter;
    // xterm measures its cell size when it opens; a face that arrives later would leave a wrong grid behind.
    const observer = new ResizeObserver(() => { try { fitter.fit(); } catch { /* not mounted */ } });
    const opened = ensureFontLoaded("terminal").then(() => {
      if (disposed) return;
      instance.open(host.current);
      fitter.fit();
      observer.observe(host.current);
    });
    const onFonts = () => { instance.options.fontFamily = stackFor("terminal"); void ensureFontLoaded("terminal").then(() => { try { fitter.fit(); } catch { /* not mounted */ } }); };
    window.addEventListener("jolo:fonts", onFonts);

    const call = async (method, params) => { const r = await window.jolo.call(method, params); if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.result; };
    const applyBatch = (items, meta) => {
      for (const item of items) {
        if (item.kind === "terminal" && item.value.terminalId === terminalId.current) {
          const seq = BigInt(item.value.seq);
          if (seq <= lastSeq.current) continue;
          if (seq !== lastSeq.current + 1n) { void reattach(); return; } // gap: rebuild from a snapshot
          lastSeq.current = seq;
          instance.write(decodeBase64(item.value.data));
        } else if (item.kind === "event" && item.value.type === "terminal.state" && item.value.payload.terminalId === terminalId.current) {
          setStatus(item.value.payload.state === "exited" ? `shell exited (${item.value.payload.exitCode ?? "signal"})` : "running");
          onState?.(item.value.payload);
        }
      }
      if (meta?.terminalDropped) void reattach();
    };
    const off = window.jolo.onEvents(applyBatch);
    const reattach = async () => {
      if (!terminalId.current) return;
      const { snapshot, seq } = await call("terminal.attach", { terminalId: terminalId.current });
      instance.reset();
      instance.write(snapshot);
      lastSeq.current = BigInt(seq);
    };
    (async () => {
      try {
        await opened;
        if (disposed) return;
        const result = attachTo
          ? await call("terminal.attach", { terminalId: attachTo })
          : await call("terminal.open", { workspaceId, cols: instance.cols, rows: instance.rows });
        if (disposed) { if (!attachTo) await call("terminal.close", { terminalId: result.terminal.terminalId }).catch(() => {}); return; }
        terminalId.current = result.terminal.terminalId;
        lastSeq.current = BigInt(result.seq);
        instance.write(result.snapshot);
        setStatus("running");
        instance.focus();
      } catch (error) {
        setStatus(error.message);
      }
    })();
    const inputDisposable = instance.onData((data) => { if (terminalId.current) call("terminal.input", { terminalId: terminalId.current, data }).catch((error) => setStatus(error.message)); });
    const resizeDisposable = instance.onResize(({ cols, rows }) => { if (terminalId.current) call("terminal.resize", { terminalId: terminalId.current, cols, rows }).catch(() => {}); });
    // One hook per workspace: split panes each own a terminal, and one closing must not blind the others.
    const hook = {
      get ready() { return Boolean(terminalId.current); },
      fontFamily: () => instance.options.fontFamily,
      input: (data) => call("terminal.input", { terminalId: terminalId.current, data }),
      text: () => { if (!terminalId.current) return ""; const b = instance.buffer.active; const lines = []; for (let i = 0; i < b.length; i += 1) lines.push(b.getLine(i)?.translateToString(true) ?? ""); return lines.join("\n").trim(); },
    };
    const hookId = paneId ?? workspaceId;
    window.__joloTerminals ??= new Map();
    window.__joloTerminals.set(hookId, hook);
    window.__joloTerminal = hook;
    return () => {
      disposed = true;
      off();
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      if (terminalId.current && !attachTo) call("terminal.close", { terminalId: terminalId.current }).catch(() => {}); // a hosted agent outlives its view
      window.__joloTerminals?.delete(hookId);
      if (window.__joloTerminal === hook) window.__joloTerminal = [...(window.__joloTerminals?.values() ?? [])].at(-1);
      appearance.removeEventListener("change", updateTheme);
      window.removeEventListener("jolo:fonts", onFonts);
      instance.dispose();
    };
  }, [workspaceId, paneId, attachTo, onState]);

  return (
    <section className="terminal">
      <div className="bar"><span>Terminal</span><span className="hint">{status}</span></div>
      <div className="xterm-host" ref={host} />
    </section>
  );
}
