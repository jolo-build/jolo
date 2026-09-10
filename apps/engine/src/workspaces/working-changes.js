// Repository state includes edits from hosted agents, shells, and external editors.
import { capture } from '../processes/capture.js';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { ProtocolError } from '@jolo/protocol';
import { resolveWorkspacePath } from '../tools/paths.js';

function git(workspace, env, args) {
  return capture([env.git, '--literal-pathspecs', ...args], { cwd: workspace.path, env: { PATH: env.path, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
}
const failure = result => new ProtocolError('unavailable', `Could not read working changes: ${result.stderr?.toString().trim().slice(0, 300) || result.error?.message || 'Git did not complete'}`);
const validPath = value => value && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '..' || part === '.git') && !value.includes('\0');

export async function workingChanges(workspace, env) {
  if (!env.git) return { files: [], source: 'none', truncated: false };
  const prefixResult = await git(workspace, env, ['rev-parse', '--show-prefix']);
  if (prefixResult.exitCode !== 0) {
    if (/not a git repository/i.test(prefixResult.stderr.toString())) return { files: [], source: 'none', truncated: false };
    throw failure(prefixResult);
  }
  const prefix = prefixResult.stdout.toString().replace(/\r?\n$/, '');
  const result = await git(workspace, env, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (result.exitCode !== 0) throw failure(result);
  const fields = result.stdout.toString('utf8').split('\0'), files = [];
  let truncated = false;
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const status = fields[i].slice(0, 2), target = fields[i].slice(3);
    const original = /[RC]/.test(status) ? fields[++i] : null;
    if (!target.startsWith(prefix)) continue;
    const relative = target.slice(prefix.length);
    if (!validPath(relative)) continue;
    if (files.length >= 1000) { truncated = true; break; }
    let revision = status;
    try { const stat = lstatSync(path.join(workspace.path, relative)); revision += `:${stat.mtimeMs}:${stat.size}`; } catch { /* deletion */ }
    const old = original?.startsWith(prefix) ? original.slice(prefix.length) : null;
    const rename = status.includes('R') && validPath(old);
    files.push({ path: rename ? old : relative, ...(rename ? { newPath: relative } : {}), op: rename ? 'rename' : /[?AC]/.test(status) ? 'create' : status.includes('D') ? 'delete' : 'replace', revision });
  }
  return { files, source: 'git', truncated };
}

export async function workingDiff(workspace, env, relative) {
  if (relative !== undefined && !validPath(relative)) throw new ProtocolError('invalid_params', 'path must stay inside the workspace');
  if (relative) {
    try { resolveWorkspacePath(workspace.path, path.dirname(relative), { mustExist: false }); }
    catch (error) { throw new ProtocolError('permission_denied', error.message); }
  }
  if (!env.git) return { diff: '', source: 'none', truncated: false };
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
  const paths = relative ? [relative] : ['.'];
  let result = await git(workspace, env, ['diff', ...flags, 'HEAD', '--', ...paths]);
  const unborn = result.exitCode !== 0 && /bad revision|ambiguous argument 'HEAD'/i.test(result.stderr.toString());
  if (unborn) result = await git(workspace, env, ['diff', ...flags, '--', ...paths]);
  if (result.exitCode !== 0) {
    if (/not a git repository/i.test(result.stderr.toString())) return { diff: '', source: 'none', truncated: false };
    throw failure(result);
  }
  // Git diff omits untracked files (and staged additions in an unborn repository).
  if (relative && (unborn || !result.stdout.length)) {
    const tracked = await git(workspace, env, ['ls-files', '--error-unmatch', '--', relative]);
    if (unborn || tracked.exitCode !== 0) {
      try {
        const stat = lstatSync(path.join(workspace.path, relative));
        if (stat.isFile() || stat.isSymbolicLink()) {
          result = await git(workspace, env, ['diff', '--no-index', ...flags, '--', '/dev/null', relative]);
          if (![0, 1].includes(result.exitCode)) throw failure(result);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const text = result.stdout.toString('utf8');
  return { diff: text.slice(0, 256 * 1024), truncated: text.length > 256 * 1024, source: 'git' };
}
