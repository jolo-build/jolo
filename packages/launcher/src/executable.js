// Resolve the same release layouts for Electron and Bun clients. Source entry is
// supplied by the application; this package has no dependency on the engine.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function engineCommand({ engineDir, sourceEntry, extraArgs = [], env = process.env, execPath = process.execPath, isBun = typeof Bun !== 'undefined' }) {
  if (env.JOLO_ENGINE_CMD) {
    const command = JSON.parse(env.JOLO_ENGINE_CMD);
    if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value)) throw new Error('JOLO_ENGINE_CMD must be a non-empty JSON argv array');
    return [...command, ...extraArgs];
  }
  const compiled = path.join(path.dirname(execPath), 'jolo-engine');
  if (isBun && path.basename(execPath) !== 'bun' && existsSync(compiled)) return [compiled, 'serve', ...extraArgs];
  const bundled = path.join(engineDir, 'engine.js');
  const entry = existsSync(bundled) ? bundled : typeof sourceEntry === 'function' ? sourceEntry() : sourceEntry;
  const candidates = [env.JOLO_BUN, path.join(engineDir, 'bun'), ...(isBun ? [execPath] : []), ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'bun')), path.join(os.homedir(), '.bun/bin/bun')];
  const runtime = candidates.find(candidate => candidate && existsSync(candidate));
  if (!runtime) throw new Error('Bun runtime not found; install the pinned runtime or set JOLO_BUN');
  if (!entry || !existsSync(entry)) throw new Error('Jolo engine entry not found; rebuild the application');
  return [runtime, entry, 'serve', ...extraArgs];
}
