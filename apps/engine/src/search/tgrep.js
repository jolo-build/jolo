// One engine-owned index per workspace. A cold, unhealthy, or stopped index never answers a search.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const SEARCH_FILE_MAX_BYTES = 1024 * 1024;
export const INDEX_IDLE_MS = 5 * 60_000;
const HEALTH_TIMEOUT_MS = 1000;

export function queryStatus(port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('search cancelled')); return; }
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(value); };
    const abort = () => finish(new Error('search cancelled'));
    const timer = setTimeout(() => finish(new Error('tgrep status timed out')), HEALTH_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write('{"jsonrpc":"2.0","id":1,"method":"status"}\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 64 * 1024) { finish(new Error('tgrep status exceeded limit')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.id !== 1 || !response.result || response.error) throw new Error('invalid tgrep status');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!buffer.includes('\n')) finish(new Error('tgrep closed status connection')); });
  });
}

export class TgrepService {
  constructor({ directory, env, log, idleMs = INDEX_IDLE_MS, maxServers = 2 }) {
    this.directory = directory;
    this.env = env;
    this.log = log;
    this.idleMs = idleMs;
    this.maxServers = maxServers;
    this.entries = new Map();
    this.retryAfter = new Map();
    this.closed = false;
    this.timer = setInterval(() => {
      for (const entry of this.entries.values()) if (!entry.users && Date.now() - entry.usedAt > this.idleMs) void this.stop(entry);
    }, Math.min(idleMs, 30_000));
    this.timer.unref?.();
  }

  ensure(root) {
    if (this.closed || !this.env.tgrep || Date.now() < (this.retryAfter.get(root) ?? 0)) return null;
    const current = this.entries.get(root);
    if (current && !current.done) { current.usedAt = Date.now(); return current; }
    if (current) this.entries.delete(root);
    if (this.entries.size >= this.maxServers) {
      const idle = [...this.entries.values()].filter(entry => !entry.users).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!idle) return null;
      void this.stop(idle);
    }
    const key = createHash('sha256').update(root).digest('hex').slice(0, 32);
    const indexPath = path.join(this.directory, key);
    mkdirSync(indexPath, { recursive: true, mode: 0o700 });
    const cached = existsSync(path.join(indexPath, 'meta.json'));
    const child = Bun.spawn([this.env.tgrep, 'serve', root, '--index-path', indexPath, '--max-filesize', String(SEARCH_FILE_MAX_BYTES), '--max-memory', '128', '--max-cpu', '25', '--watch-budget', '2048'], {
      cwd: root, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: { PATH: this.env.path },
    });
    const entry = { root, indexPath, child, cached, done: false, usedAt: Date.now(), users: 0, dirtyUntil: 0, diagnostics: '' };
    this.entries.set(root, entry);
    void (async () => {
      for await (const chunk of child.stderr) entry.diagnostics = (entry.diagnostics + Buffer.from(chunk).toString('utf8')).slice(-2048);
    })().catch(() => {});
    void child.exited.then(code => {
      entry.done = true;
      if (this.entries.get(root) === entry) this.entries.delete(root);
      if (code && !entry.stopping) {
        this.retryAfter.set(root, Date.now() + 30_000);
        this.log?.warn('tgrep server exited', { code, detail: entry.diagnostics });
      }
    });
    return entry;
  }

  invalidate(root) {
    const entry = this.entries.get(root);
    if (entry) entry.dirtyUntil = Date.now() + 2000;
  }

  async acquire(root, signal) {
    let entry;
    try {
      entry = this.ensure(root);
      if (!entry || signal?.aborted || Date.now() < entry.dirtyUntil) return null;
      const info = JSON.parse(readFileSync(path.join(entry.indexPath, 'serve.json'), 'utf8'));
      // Never connect to an unrelated server or reuse a discovery file from a previous boot.
      if (info.pid !== entry.child.pid || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return null;
      const status = await queryStatus(info.port, signal);
      if (entry.stopping || entry.done || status.indexing !== false || status.reconcile_running || status.reconcile_pending || status.reconcile_overdue || status.last_reconcile_error || status.watch_mode_active !== 'native' || (entry.cached && !status.last_reconcile_at)) return null;
      entry.users++;
      let released = false;
      return { indexPath: entry.indexPath, pid: entry.child.pid, alive: () => !entry.done && !entry.stopping,
        cancel: () => this.stop(entry),
        release: () => { if (!released) { released = true; entry.users--; entry.usedAt = Date.now(); } } };
    } catch (error) {
      if (!entry) {
        this.retryAfter.set(root, Date.now() + 30_000);
        this.log?.warn('tgrep unavailable; using live search', { error: error.message });
      }
      return null;
    }
  }

  async stop(entry) {
    if (entry.stopping) return entry.stopping;
    if (this.entries.get(entry.root) === entry) this.entries.delete(entry.root);
    entry.stopping = (async () => {
      if (entry.done) return;
      entry.child.kill('SIGTERM');
      const force = setTimeout(() => { if (!entry.done) entry.child.kill('SIGKILL'); }, 2000);
      try { await entry.child.exited; } finally { clearTimeout(force); }
    })();
    return entry.stopping;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...this.entries.values()].map(entry => this.stop(entry)));
  }
}
