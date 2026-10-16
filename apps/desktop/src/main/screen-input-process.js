// The desktop's link to `engine screen-input`: one child process, JSON lines both ways, requests
// answered in order. Spawned by the desktop so macOS attributes input and capture to Jolo, and so
// control ends when the desktop does.
import { spawn } from 'node:child_process';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * @param {{ command: string[], log: any, spawnImpl?: typeof spawn }} options
 */
export function createScreenInputProcess({ command, log, spawnImpl = spawn }) {
  let child = null;
  let buffer = '';
  let sequence = 0;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
  const pending = new Map();

  const failAll = (error) => { for (const [id, entry] of pending) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); } };
  const start = () => {
    if (child && child.exitCode === null && !child.killed) return child;
    child = spawnImpl(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { log.warn('screen input sent an unreadable line'); continue; }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(Object.assign(new Error(message.error?.message ?? 'screen input failed'), { code: message.error?.code ?? 'input_failed' }));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => log.warn('screen input stderr', { text: String(chunk).slice(0, 500) }));
    const exited = child;
    child.on('exit', (code, signal) => {
      if (child === exited) child = null;
      failAll(Object.assign(new Error(`screen input helper exited (${signal ?? code})`), { code: 'helper_exited' }));
    });
    child.on('error', error => {
      if (child === exited) child = null;
      failAll(Object.assign(new Error(`screen input helper could not start: ${error.message}`), { code: 'helper_unavailable' }));
    });
    return child;
  };

  return {
    /** @param {string} cmd @param {Record<string, unknown>} [args] */
    request(cmd, args = {}) {
      const process = start();
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`screen input ${cmd} timed out`), { code: 'timeout' })); }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        process.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
      });
    },
    close() {
      failAll(Object.assign(new Error('screen input closed'), { code: 'cancelled' }));
      if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
      child = null;
    },
  };
}
