// Engine terminal service: owns PTYs, dimensions, input leases, and the
// authoritative bounded screen state. Clients receive snapshots plus subsequent bytes and render a
// disposable projection. Terminal input is a user operation and never creates agent grants.
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ProtocolError, TERMINAL_LIMITS } from "@jolo/protocol";
import { newId } from "../storage/index.js";

const OUTPUT_QUEUE_MAX_BYTES = 512 * 1024;

export class TerminalService {
  /** @param {{ storage: any, supervisor: any, lifetime: any, log: any, shell?: string }} options */
  constructor(options) {
    this.storage = options.storage;
    this.supervisor = options.supervisor;
    this.lifetime = options.lifetime;
    this.log = options.log;
    this.shell = options.shell ?? null;
    /** @type {Map<string, any>} */
    this.terminals = new Map();
    this.watchers = new Set();
    this.closing = new Set();
  }

  describe(t) {
    return { terminalId: t.id, workspaceId: t.workspaceId, cols: t.cols, rows: t.rows, state: t.state, exitCode: t.exitCode, keepAlive: t.keepAlive, createdAt: t.createdAt, agentId: t.agentId ?? null };
  }

  /** The visible screen as plain text, for anything that has to read what a hosted agent is showing. */
  screenText(terminal) {
    const buffer = terminal.screen.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
  }

  /** Observers are notified after every write and on exit; used to watch a hosted agent (§4.3). */
  watch(handler) {
    this.watchers.add(handler);
    return () => this.watchers.delete(handler);
  }

  notifyWatchers(terminal, kind) {
    if (!this.watchers) return;
    for (const handler of this.watchers) {
      try { handler(terminal, kind); } catch (error) { this.log.warn("terminal watcher failed", { error: String(error?.message ?? error) }); }
    }
  }

  find(terminalId) { return this.terminals.get(terminalId) ?? null; }

  get(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new ProtocolError("not_found", "unknown terminal");
    return terminal;
  }

  /**
   * @param {{ conn: any, workspaceId: string, cols: number, rows: number, keepAlive?: boolean,
   *           command?: string[], agentId?: string }} request a command launches that argv instead of a shell
   */
  open({ conn, workspaceId, cols, rows, keepAlive, command = null, agentId = null }) {
    if (this.terminals.size >= 32 || this.list(workspaceId).length >= 8) throw new ProtocolError("limit_exceeded", "terminal limit reached; close an existing terminal first");
    const workspace = this.storage.getWorkspace(workspaceId);
    if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
    const shell = this.shell ?? this.supervisor.baseEnv.SHELL ?? "/bin/sh";
    const argv = command ?? [shell];
    const id = newId("term");
    const screen = new Terminal({ cols, rows, scrollback: TERMINAL_LIMITS.scrollbackLines, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const terminal = { id, workspaceId, agentId, cols, rows, keepAlive, state: "running", exitCode: null, createdAt: new Date().toISOString(), owner: conn, subscribers: new Set([conn]), screen, serializer, seq: 0n, proc: null, pendingBytes: 0, title: "" };
    screen.onTitleChange?.((title) => { terminal.title = String(title ?? "").slice(0, 200); });
    const env = this.supervisor.environment({ TERM: "xterm-256color", COLORTERM: "truecolor", LANG: this.supervisor.baseEnv.LANG ?? "en_US.UTF-8" });
    try {
      terminal.proc = Bun.spawn(argv, {
        cwd: workspace.path,
        detached: true,
        env,
        terminal: {
          cols, rows,
          data: (_pty, chunk) => this.output(terminal, chunk),
        },
        onExit: (_proc, exitCode) => this.exited(terminal, exitCode),
      });
    } catch (error) {
      screen.dispose();
      throw new ProtocolError("unavailable", `could not start ${argv[0]}: ${error?.message ?? error}`);
    }
    this.terminals.set(id, terminal);
    if (keepAlive) this.lifetime.workStarted(); // retained user shells keep the engine alive (§14.2)
    conn.closeHooks.add(() => this.onDisconnect(conn, terminal));
    this.storage.appendEvent({ type: "terminal.opened", payload: { terminalId: id, workspaceId, keepAlive } });
    return { terminal: this.describe(terminal), snapshot: this.snapshot(terminal), seq: String(terminal.seq), inputLease: true };
  }

  output(terminal, chunk) {
    if (terminal.disposed) return;
    const buffer = Buffer.from(chunk);
    terminal.pendingBytes += buffer.length;
    if (terminal.pendingBytes > OUTPUT_QUEUE_MAX_BYTES) {
      this.log.warn("terminal output exceeded screen queue limit", { terminalId: terminal.id });
      this.dispose(terminal, "output queue exceeded limit");
      return;
    }
    terminal.screen.write(buffer, () => { terminal.pendingBytes -= buffer.length; });
    for (let offset = 0; offset < buffer.length; offset += 32 * 1024) {
      terminal.seq += 1n;
      const message = { terminalId: terminal.id, seq: String(terminal.seq), data: buffer.subarray(offset, offset + 32 * 1024).toString("base64") };
      for (const conn of terminal.subscribers) {
        if (conn.closed) { terminal.subscribers.delete(conn); continue; }
        conn.notify("terminal.output", message);
      }
    }
    this.notifyWatchers(terminal, "output");
  }

  exited(terminal, exitCode) {
    if (terminal.disposed) return;
    terminal.state = "exited";
    terminal.exitCode = exitCode ?? null;
    for (const conn of terminal.subscribers) if (!conn.closed) conn.notify("terminal.state", { terminalId: terminal.id, state: "exited", exitCode: terminal.exitCode });
    if (terminal.keepAlive) { terminal.keepAlive = false; this.lifetime.workFinished(); }
    this.notifyWatchers(terminal, "exit");
  }

  snapshot(terminal) {
    // Quartered on each pass until the snapshot fits the frame, so this is a count, not the constant.
    /** @type {number} */
    let scrollback = TERMINAL_LIMITS.scrollbackLines;
    for (;;) {
      const text = terminal.serializer.serialize({ scrollback });
      // Include JSON escaping: ANSI-heavy screens can be much larger on the wire.
      if (Buffer.byteLength(JSON.stringify(text)) <= 230 * 1024) return text;
      if (scrollback === 0) {
        const buffer = terminal.screen.buffer.active;
        const lines = [];
        for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
        return "\x1b[0m\x1b[H" + lines.join("\r\n");
      }
      scrollback = Math.floor(scrollback / 4);
    }
  }

  attach({ conn, terminalId }) {
    const terminal = this.get(terminalId);
    terminal.subscribers.add(conn);
    conn.closeHooks.add(() => terminal.subscribers.delete(conn));
    return { terminal: this.describe(terminal), snapshot: this.snapshot(terminal), seq: String(terminal.seq), inputLease: terminal.owner === conn };
  }

  requireLease(conn, terminal) {
    if (terminal.owner !== conn) throw new ProtocolError("permission_denied", "another client holds the input lease for this terminal");
    if (terminal.state !== "running") throw new ProtocolError("conflict", "the terminal has exited");
  }

  input({ conn, terminalId, data }) {
    const terminal = this.get(terminalId);
    this.requireLease(conn, terminal);
    terminal.proc.terminal.write(data);
    return { accepted: true };
  }

  resize({ conn, terminalId, cols, rows }) {
    const terminal = this.get(terminalId);
    this.requireLease(conn, terminal);
    terminal.cols = cols;
    terminal.rows = rows;
    terminal.screen.resize(cols, rows);
    try { terminal.proc.terminal.resize(cols, rows); } catch (error) { this.log.warn("pty resize failed", { error: String(error?.message ?? error) }); }
    return { cols, rows };
  }

  /** Input leases are revisioned and transferred explicitly (§16.1); the owner's disconnect frees them. */
  lease({ conn, terminalId }) {
    const terminal = this.get(terminalId);
    if (terminal.owner && !terminal.owner.closed && terminal.owner !== conn) throw new ProtocolError("conflict", "the current owner is still attached; it must release the terminal first");
    terminal.owner = conn;
    terminal.subscribers.add(conn);
    return { inputLease: true };
  }

  close({ terminalId }) {
    const terminal = this.get(terminalId);
    this.dispose(terminal, "closed");
    return { closed: true };
  }

  dispose(terminal, reason) {
    if (!this.terminals.has(terminal.id)) return;
    this.terminals.delete(terminal.id);
    terminal.disposed = true;
    if (terminal.state === "running") {
      const signal = name => {
        if (terminal.proc.exitCode !== null) return;
        try { process.kill(-terminal.proc.pid, name); }
        catch { try { terminal.proc.kill(name); } catch { /* gone */ } }
      };
      signal("SIGHUP");
      const terminate = setTimeout(() => signal("SIGTERM"), 500);
      const kill = setTimeout(() => signal("SIGKILL"), 1500);
      let deadline;
      const settled = Promise.race([terminal.proc.exited, new Promise(resolve => { deadline = setTimeout(resolve, 2000); })]).finally(() => {
        clearTimeout(terminate); clearTimeout(kill); clearTimeout(deadline); this.closing.delete(settled);
      });
      this.closing.add(settled);
    }
    try { terminal.proc?.terminal?.close(); } catch { /* ignore */ }
    terminal.screen.dispose();
    for (const conn of terminal.subscribers) if (!conn.closed) conn.notify("terminal.state", { terminalId: terminal.id, state: "exited", exitCode: terminal.exitCode });
    if (terminal.keepAlive) { terminal.keepAlive = false; this.lifetime.workFinished(); }
    this.storage.appendEvent({ type: "terminal.closed", payload: { terminalId: terminal.id, workspaceId: terminal.workspaceId, reason } });
    this.notifyWatchers(terminal, "disposed");
  }

  onDisconnect(conn, terminal) {
    if (!this.terminals.has(terminal.id)) return;
    terminal.subscribers.delete(conn);
    if (terminal.owner === conn) {
      terminal.owner = null;
      if (!terminal.keepAlive) this.dispose(terminal, "controlling client disconnected"); // §14.2 default
    }
  }

  list(workspaceId) {
    return [...this.terminals.values()].filter((t) => !workspaceId || t.workspaceId === workspaceId).map((t) => this.describe(t));
  }

  async stopAll() {
    for (const terminal of [...this.terminals.values()]) this.dispose(terminal, "engine stopping");
    await Promise.allSettled([...this.closing]);
  }
}
