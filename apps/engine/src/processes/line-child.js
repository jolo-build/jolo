import { GUARDIAN_SOURCE } from "./guardian.js";
// Bounded NDJSON transport. Drain independently of slow consumers and kill the
// process group on cancellation, malformed oversized output, or queue overflow.
/**
 * Spawn a child that speaks newline-delimited JSON on its stdio. Cancelling the run first gives the
 * adapter a chance to say so politely (`onCancel`, which returns true when it did), then the child
 * is terminated after a grace period.
 * @param {{ argv: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, onCancel?: () => boolean | void, log: any, agentId: string, maxLineBytes?: number, maxQueueBytes?: number }} options
 */
export function spawnLineChild({ argv, cwd, env, signal, onCancel, log, agentId, maxLineBytes = 8 * 1024 * 1024, maxQueueBytes = 16 * 1024 * 1024 }) {
  const child = Bun.spawn([process.execPath, "--eval", GUARDIAN_SOURCE, "--", ...argv], { cwd, env, detached: process.platform !== 'win32', stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const graceMs = 2000;
  let diagnostics = '', ended = false, failure = null, wake = null, queuedBytes = 0;
  const queue = [];
  const timers = new Set();
  let terminating = false;
  const kill = signalName => {
    if (child.exitCode !== null) return; // Never signal a recycled process group after our guardian exits.
    try { if (process.platform === 'win32') child.kill(signalName); else process.kill(-child.pid, signalName); }
    catch (error) { if (error.code !== 'ESRCH') log.warn('hosted process group signal failed', { agentId, error: String(error) }); }
  };
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };
  const terminate = ({ graceful = false } = {}) => {
    if (terminating) return;
    terminating = true;
    if (graceful) later(() => kill('SIGTERM'), graceMs); else kill('SIGTERM');
    later(() => kill('SIGKILL'), (graceful ? 2 : 1) * graceMs);
  };
  const write = message => {
    try { child.stdin.write(`${JSON.stringify(message)}\n`); child.stdin.flush?.(); }
    catch { /* exited children are observed by the reader */ }
  };
  const onAbort = () => { let graceful = false; try { graceful = onCancel?.() === true; } catch {} terminate({ graceful }); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const stderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) diagnostics = (diagnostics + decoder.decode(chunk, { stream: true })).slice(-8192);
  })().catch(() => {});
  const notify = () => { const waiting = wake; wake = null; waiting?.(); };
  const stdout = (async () => {
    let pieces = [], bytes = 0;
    const line = () => {
      const text = Buffer.concat(pieces, bytes).toString('utf8');
      pieces = []; bytes = 0;
      if (!text.trim()) return;
      let message;
      try { message = JSON.parse(text); } catch { log.warn('hosted agent sent a line that is not JSON', { agentId, bytes: Buffer.byteLength(text) }); return; }
      const size = Buffer.byteLength(text);
      if (queuedBytes + size > maxQueueBytes || queue.length >= 2048) throw new Error('hosted agent output queue exceeded limit');
      queuedBytes += size;
      queue.push({ message, size });
      notify();
    };
    for await (const data of child.stdout) {
      const chunk = Buffer.from(data);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(offset, end);
        bytes += piece.length;
        if (bytes > maxLineBytes) throw new Error('hosted agent output line exceeded limit');
        pieces.push(piece);
        if (newline >= 0) line();
        offset = end + 1;
      }
    }
    if (bytes) line();
  })().catch(error => { failure = error; terminate(); }).finally(() => { ended = true; notify(); });
  async function* messages() {
    try {
      for (;;) {
        if (signal.aborted) return;
        if (failure) throw failure;
        if (queue.length) { const item = queue.shift(); queuedBytes -= item.size; yield item.message; continue; }
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
      }
    } finally { if (!ended) terminate(); }
  }
  return {
    child, write, messages, terminate,
    end() { try { child.stdin.end(); } catch {} },
    async settle() {
      // Always clean up descendants, including ones that inherited the pipes.
      terminate({ graceful: true });
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([child.exited, stdout, stderr]),
          new Promise(resolve => { timer = setTimeout(resolve, 2 * graceMs + 250); }),
        ]);
      } finally {
        clearTimeout(timer);
        kill('SIGKILL');
        for (const timer of timers) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
      return { exitCode: child.exitCode, stderr: diagnostics.trim() };
    },
  };
}
