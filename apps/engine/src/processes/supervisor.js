// Process supervisor: process groups, bounded spools, deadlines,
// cooperative cancellation with escalation, recovery markers. Commands run with the user's privileges.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const GRACE_MS = 2_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "XDG_RUNTIME_DIR", "SSL_CERT_FILE"];

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
export const stripControls = (text) => text.replace(ANSI, "");

export class ProcessSupervisor {
  /** @param {{ storage: any, log: any, env: { path: string }, recoveryDir: string, baseEnv?: Record<string, string | undefined> }} options */
  constructor(options) {
    this.storage = options.storage;
    this.log = options.log;
    this.toolPath = options.env.path;
    this.recoveryDir = options.recoveryDir;
    this.baseEnv = options.baseEnv ?? process.env;
    /** @type {Map<string, any>} */
    this.active = new Map();
    mkdirSync(this.recoveryDir, { recursive: true, mode: 0o700 });
  }

  /** Minimal environment profile: no provider credentials, no login-shell initialization (§10.3). */
  hostedEnvironment(extra = {}) {
    const env = this.environment({ TERM: "dumb", ...extra });
    for (const key of ["CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CODEX_HOME", "GROK_HOME"]) if (this.baseEnv[key]) env[key] = this.baseEnv[key];
    return env;
  }

  /** @param {Record<string, string>} [extra] */
  environment(extra = {}) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const key of ENV_ALLOWLIST) if (this.baseEnv[key] !== undefined) env[key] = this.baseEnv[key];
    env.PATH = this.toolPath;
    env.TERM = "dumb";
    env.JOLO = "1";
    for (const [key, value] of Object.entries(extra)) if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) env[key] = value;
    return env;
  }

  /**
   * @param {{ invocationId: string, sessionId: string, command: string[], cwd: string, timeoutMs: number, signal: AbortSignal, onOutput?: (text: string) => void, shellScript?: string }} request
   */
  run(request) {
    const startedAt = Date.now();
    const artifact = this.storage.createArtifact({ sessionId: request.sessionId, kind: "command-output" });
    const writer = this.storage.openArtifactWriter(artifact);
    const [command, ...args] = request.command;
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try { child = spawn(command, args, { cwd: request.cwd, env: this.environment(), stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (error) { try { writer.close(); } catch {} throw error; }
    const marker = path.join(this.recoveryDir, `${request.invocationId}.json`);
    const record = { invocationId: request.invocationId, pid: child.pid ?? null, startedAt: new Date(startedAt).toISOString(), command: request.command.slice(0, 8), cwd: request.cwd };
    try { writeFileSync(`${marker}.tmp`, JSON.stringify(record), { mode: 0o600 }); renameSync(`${marker}.tmp`, marker); } catch { /* diagnostics only */ }
    this.active.set(request.invocationId, child);

    let head = [];
    let headBytes = 0;
    let tail = [];
    let tailBytes = 0;
    let total = 0;
    let truncated = false;
    let spoolBytes = 0;
    const SPOOL_MAX = 32 * 1024 * 1024; // retained output per tool (§12.4)
    let outputError = null;
    const consume = (chunk) => {
      if (outputError) return;
      try {
      total += chunk.length;
      if (spoolBytes + chunk.length <= SPOOL_MAX) { writer.append(chunk); spoolBytes += chunk.length; } else truncated = true;
      if (headBytes < HEAD_BYTES) { const take = chunk.subarray(0, HEAD_BYTES - headBytes); head.push(Buffer.from(take)); headBytes += take.length; }
      tail.push(Buffer.from(chunk)); tailBytes += chunk.length;
      while (tailBytes > TAIL_BYTES && tail.length > 1) { tailBytes -= tail[0].length; tail.shift(); }
      request.onOutput?.(stripControls(chunk.toString("utf8")));
      } catch (error) { outputError = error; terminate("output_failure"); }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", () => {});

    let killed = null, escalation = null;
    const killGroup = (sig) => { try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const terminate = (reason) => {
      if (killed) return;
      killed = reason;
      killGroup("SIGTERM");
      escalation = setTimeout(() => { if (this.active.get(request.invocationId) === child) killGroup("SIGKILL"); }, GRACE_MS);
      escalation.unref?.();
    };
    const deadline = setTimeout(() => terminate("timeout"), request.timeoutMs);
    const onAbort = () => terminate("cancelled");
    request.signal.addEventListener("abort", onAbort, { once: true });

    if (request.signal.aborted) onAbort();
    return new Promise((resolve, reject) => {
      child.on("close", (exitCode, signalCode) => {
        clearTimeout(deadline); clearTimeout(escalation);
        request.signal.removeEventListener("abort", onAbort);
        this.active.delete(request.invocationId);
        try {
        const committed = writer.close();
        this.storage.finalizeArtifact(artifact.id, committed, null);
        if (outputError) throw outputError;
        try { unlinkSync(marker); } catch { /* absent */ }
        const headText = stripControls(Buffer.concat(head).toString("utf8"));
        const tailText = total > HEAD_BYTES + TAIL_BYTES ? stripControls(Buffer.concat(tail).toString("utf8")) : "";
        resolve({
          exitCode, signal: signalCode ?? null, killed, durationMs: Date.now() - startedAt,
          outputArtifactId: artifact.id, outputBytes: total, spoolTruncated: truncated,
          head: headText, tail: tailText, omittedBytes: Math.max(0, total - HEAD_BYTES - (tailText ? TAIL_BYTES : 0)),
        });
        } catch (error) { try { writer.close(); } catch {} reject(error); }
      });
    });
  }

  /** Startup reconciliation (§14.4): unknown outcomes stay unknown; PIDs are never killed blindly. */
  reconcile() {
    const unknown = [];
    for (const name of readdirSync(this.recoveryDir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.recoveryDir, name);
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        unknown.push(record);
        const invocation = this.storage.getInvocation(record.invocationId);
        if (invocation && !["completed", "failed"].includes(invocation.state)) this.storage.updateInvocation(record.invocationId, { state: "failed", exitData: { status: "unknown", note: "engine restarted while the command was running; outcome unknown", pid: record.pid } });
      } catch { /* corrupt marker */ }
      try { unlinkSync(file); } catch { /* ignore */ }
    }
    if (unknown.length) this.log.warn("commands with unknown outcomes from a previous boot", { count: unknown.length, pids: unknown.map((r) => r.pid) });
    return unknown;
  }

  async stopAll() {
    if (this.active.size === 0) return;
    for (const child of this.active.values()) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ } }
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
    for (const child of this.active.values()) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ } }
  }
}
