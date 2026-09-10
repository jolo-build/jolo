// Hosting another vendor's coding-agent CLI.
//
// Jolo launches the agent in an engine-owned terminal inside a workspace and then watches it. It does not
// drive the agent, cannot approve anything on its behalf, and grants it nothing: the child runs with the
// user's own privileges, exactly like a shell the user opened. Jolo's permission model covers Jolo's tools,
// not another program's, and that boundary is deliberate rather than an omission.
import { detectStatus } from "./status.js";

const EVALUATE_THROTTLE_MS = 250;
const TICK_MS = 1_000;

export class AgentService {
  /** @param {{ catalog: any, terminals: any, storage: any, log: any }} options */
  constructor(options) {
    this.catalog = options.catalog;
    this.terminals = options.terminals;
    this.storage = options.storage;
    this.log = options.log;
    /** @type {Map<string, any>} terminalId -> hosted agent */
    this.sessions = new Map();
    this.tick = null;
    this.unwatch = this.terminals.watch((terminal, kind) => this.onTerminal(terminal, kind));
  }

  describe(session) {
    return {
      terminalId: session.terminalId, workspaceId: session.workspaceId, agentId: session.agentId,
      displayName: session.displayName, status: session.status, statusSource: session.statusSource,
      statusDetail: session.statusDetail, exitCode: session.exitCode,
      startedAt: session.startedAt, lastActivityAt: new Date(session.lastOutputAt).toISOString(),
    };
  }

  start({ conn, workspaceId, agentId, cols, rows, prompt }) {
    const manifest = this.catalog.get(agentId);
    const command = this.catalog.command(manifest, { prompt });
    // A hosted agent holds the engine open the way a kept shell does: its work outlives the client (§14.2).
    const opened = this.terminals.open({ conn, workspaceId, cols, rows, keepAlive: true, command, agentId });
    const now = Date.now();
    const session = {
      terminalId: opened.terminal.terminalId, workspaceId, agentId, manifest,
      displayName: manifest.displayName, status: "starting", statusSource: "process", statusDetail: null,
      exitCode: null, startedAt: new Date(now).toISOString(), lastOutputAt: now, evaluatedAt: 0, started: false,
    };
    this.sessions.set(session.terminalId, session);
    this.storage.appendEvent({ type: "agent.started", payload: { terminalId: session.terminalId, workspaceId, agentId, displayName: manifest.displayName, binary: command[0] } });
    this.log.info("hosted agent started", { agentId, workspaceId, terminalId: session.terminalId, binary: command[0] });
    if (!this.tick) { this.tick = setInterval(() => this.sweep(), TICK_MS); this.tick.unref?.(); }
    return { agent: this.describe(session), ...opened };
  }

  onTerminal(terminal, kind) {
    const session = this.sessions.get(terminal.id);
    if (!session) return;
    if (kind === "output") {
      session.lastOutputAt = Date.now();
      session.started = true;
      if (Date.now() - session.evaluatedAt >= EVALUATE_THROTTLE_MS) this.evaluate(session, terminal);
      return;
    }
    if (kind === "exit") {
      session.exitCode = terminal.exitCode;
      this.evaluate(session, terminal);
      this.storage.appendEvent({ type: "agent.exited", payload: { terminalId: session.terminalId, workspaceId: session.workspaceId, agentId: session.agentId, exitCode: terminal.exitCode ?? null } });
      return;
    }
    if (kind === "disposed") this.sessions.delete(terminal.id);
  }

  /** Recompute one agent's status and announce it only when it actually changed. */
  evaluate(session, terminal) {
    session.evaluatedAt = Date.now();
    const next = detectStatus({
      rules: session.manifest.compiled,
      statusModel: session.manifest.statusModel,
      idleMs: session.manifest.idleMs,
      screen: this.terminals.screenText(terminal),
      title: terminal.title ?? "",
      exited: terminal.state === "exited",
      exitCode: terminal.exitCode,
      msSinceOutput: Date.now() - session.lastOutputAt,
      started: session.started,
    });
    if (next.status === session.status && next.source === session.statusSource && next.detail === session.statusDetail) return;
    session.status = next.status;
    session.statusSource = next.source;
    session.statusDetail = next.detail;
    this.storage.appendEvent({ type: "agent.status", payload: { terminalId: session.terminalId, workspaceId: session.workspaceId, agentId: session.agentId, status: next.status, source: next.source, detail: next.detail } });
  }

  /** Silence is only visible with a clock, so a timer moves a quiet agent to idle. */
  sweep() {
    for (const session of [...this.sessions.values()]) {
      const terminal = this.terminals.find(session.terminalId);
      if (!terminal) { this.sessions.delete(session.terminalId); continue; }
      this.evaluate(session, terminal);
    }
    if (this.sessions.size === 0 && this.tick) { clearInterval(this.tick); this.tick = null; }
  }

  list(workspaceId) {
    return [...this.sessions.values()].filter((session) => !workspaceId || session.workspaceId === workspaceId).map((session) => this.describe(session));
  }

  stop({ terminalId }) {
    if (!this.sessions.has(terminalId)) return this.terminals.close({ terminalId }) && { stopped: true };
    this.terminals.close({ terminalId });
    this.sessions.delete(terminalId);
    return { stopped: true };
  }

  dispose() {
    this.unwatch?.();
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    this.sessions.clear();
  }
}
