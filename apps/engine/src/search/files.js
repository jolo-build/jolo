// What the composer's "@" picker may offer: the files of a workspace that are not ignored, the folders
// they sit in, and the top-level listing of one folder. Enumeration goes through git or ripgrep, which
// both honour .gitignore; the built-in walk, for a folder with neither, only skips repository metadata
// and dependency directories. Everything is bounded to the workspace root and never follows symlinks.
// The Files panel's search in files reads the same non-ignored files through ripgrep or git grep.
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ProtocolError } from '@jolo/protocol';
import { resolveWorkspacePath, WorkspacePathError } from '../tools/paths.js';

export const FILES_MAX_ENTRIES = 50_000;
const CACHE_MS = 3000;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
const SEARCH_PER_FILE = 20;
const SEARCH_TEXT_CHARS = 200;
const SEARCH_LINE_HEAD = 64 * 1024;
/** @type {Map<string, { at: number, promise: Promise<{ files: string[], truncated: boolean, source: 'git' | 'ripgrep' | 'builtin' }> }>} */
const recent = new Map();

const pathError = error => error instanceof WorkspacePathError ? new ProtocolError(error.code === 'not_found' ? 'not_found' : 'permission_denied', error.message) : error;

/**
 * Non-ignored files under a workspace root, workspace-relative with "/" separators. Typing in the
 * picker asks several times a second, so one enumeration serves the keystrokes that follow it.
 * @param {{ root: string, env: { git?: string | null, ripgrep?: string | null, path: string }, signal: AbortSignal, limit?: number }} options
 */
export function workspaceFiles({ root, env, signal, limit = FILES_MAX_ENTRIES }) {
  const cached = recent.get(root);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.promise;
  const promise = enumerate({ root, env, signal, limit }).catch(error => { if (recent.get(root)?.promise === promise) recent.delete(root); throw error; });
  recent.set(root, { at: Date.now(), promise });
  return promise;
}

async function enumerate({ root, env, signal, limit }) {
  if (env.git) {
    const listed = await viaCommand({ root, signal, limit, command: [env.git, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], env: { PATH: env.path, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    if (listed) return { ...listed, source: /** @type {const} */ ('git') };
  }
  if (env.ripgrep) {
    const listed = await viaCommand({ root, signal, limit, command: [env.ripgrep, '--files', '--sort', 'path', '--glob', '!.git', '-0'], env: { PATH: env.path } });
    if (listed) return { ...listed, source: /** @type {const} */ ('ripgrep') };
  }
  return { ...walk({ root, signal, limit }), source: /** @type {const} */ ('builtin') };
}

/** NUL-separated paths from a listing command; null when the command cannot list this folder (not a repository, say). */
async function viaCommand({ root, signal, limit, command, env = {} }) {
  if (signal.aborted) throw new ProtocolError('interrupted', 'file listing cancelled');
  const proc = Bun.spawn(command, { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env });
  const stderr = (async () => { let text = ''; for await (const chunk of proc.stderr) text = (text + Buffer.from(chunk).toString('utf8')).slice(-2048); return text; })();
  const onAbort = () => proc.kill();
  signal.addEventListener('abort', onAbort, { once: true });
  const files = [];
  let truncated = false, partial = '', finished = false;
  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      partial += decoder.decode(value, { stream: true });
      let end;
      while ((end = partial.indexOf('\0')) !== -1) {
        const entry = partial.slice(0, end); partial = partial.slice(end + 1);
        if (!entry || entry.split('/').some(part => part === '..' || part === '.git')) continue; // never outside the workspace, never repository metadata
        if (files.length >= limit) { truncated = true; proc.kill(); break outer; }
        files.push(entry.replaceAll('\\', '/'));
      }
      if (partial.length > 64 * 1024) throw new ProtocolError('limit_exceeded', 'file listing entry is too long');
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!finished && proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  if (signal.aborted) throw new ProtocolError('interrupted', 'file listing cancelled');
  if (!truncated && proc.exitCode !== 0) { await stderr; return null; }
  return { files, truncated };
}

/** Bounded walk for a folder that is neither a repository nor served by ripgrep. */
function walk({ root, signal, limit }) {
  const files = [];
  let truncated = false;
  const visit = (absolute, relative) => {
    if (signal.aborted) throw new ProtocolError('interrupted', 'file listing cancelled');
    let names;
    try { names = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of names) {
      if (truncated) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path.join(absolute, entry.name), child); }
      else if (entry.isFile()) { if (files.length >= limit) { truncated = true; return; } files.push(child); }
    }
  };
  visit(root, '');
  return { files, truncated };
}

/**
 * How well a typed fragment fits a path: every character in order, with runs, segment starts and the
 * file's own name counting for more, and shorter paths winning ties. Null when it does not fit.
 * @param {string} query
 * @param {string} candidate workspace-relative path
 */
export function pathMatchScore(query, candidate) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const text = candidate.toLowerCase();
  const name = text.slice(text.lastIndexOf('/') + 1);
  let total = 0;
  for (const word of words) {
    let score = 0, from = 0, previous = -2;
    for (const char of word) {
      const at = text.indexOf(char, from);
      if (at < 0) return null;
      score += at === previous + 1 ? 6 : 1;
      if (at === 0 || '/._-'.includes(text[at - 1])) score += 4;
      previous = at; from = at + 1;
    }
    if (name.includes(word)) score += 20;
    if (name.startsWith(word)) score += 10;
    total += score;
  }
  return total - text.length / 50;
}

/**
 * The top level with nothing typed: folders and files in equal measure, each group by name, so a project with
 * many top-level folders still shows its files. Either group takes the rows the other leaves empty, and the
 * rest of the top level follows so a dropped entry can be filled in from behind.
 * @param {{ path: string, kind: 'file' | 'directory' }[]} entries
 * @param {number} limit
 */
export function topLevelMix(entries, limit) {
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const folders = entries.filter(entry => entry.kind === 'directory' && !entry.path.includes('/')).sort(byPath);
  const files = entries.filter(entry => entry.kind === 'file' && !entry.path.includes('/')).sort(byPath);
  const folderRows = Math.min(folders.length, Math.max(Math.ceil(limit / 2), limit - files.length));
  const fileRows = Math.min(files.length, limit - folderRows);
  return [...folders.slice(0, folderRows), ...files.slice(0, fileRows), ...folders.slice(folderRows), ...files.slice(fileRows)];
}

/**
 * The entries that fit a typed fragment, best first; with nothing typed, the top level of the workspace.
 * @param {{ root: string, env: { git?: string | null, ripgrep?: string | null, path: string }, signal: AbortSignal, query: string, limit: number }} options
 */
export async function searchWorkspaceFiles({ root, env, signal, query, limit }) {
  const { files, truncated, source } = await workspaceFiles({ root, env, signal });
  const folders = new Set();
  for (const file of files) for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) folders.add(file.slice(0, slash));
  const entries = [...[...folders].map(entry => ({ path: entry, kind: /** @type {const} */ ('directory') })), ...files.map(entry => ({ path: entry, kind: /** @type {const} */ ('file') }))];
  const byName = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.path.localeCompare(b.path);
  const ranked = query.trim()
    ? entries.map(entry => ({ entry, score: pathMatchScore(query, entry.path) })).filter(item => item.score !== null)
      .sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || byName(a.entry, b.entry)).map(item => item.entry)
    : topLevelMix(entries, limit);
  const chosen = [];
  // Only what is handed back is checked against the disk, so a long enumeration costs no extra stats.
  let considered = 0;
  for (const entry of ranked) {
    if (chosen.length >= limit) break;
    considered++;
    let stat;
    try { stat = lstatSync(path.join(root, entry.path)); } catch { continue; }
    if (stat.isSymbolicLink() || (entry.kind === 'file' ? !stat.isFile() : !stat.isDirectory())) continue;
    chosen.push(entry);
  }
  return { entries: chosen, truncated: truncated || considered < ranked.length, total: ranked.length, source };
}

/**
 * The top level of one folder, folders first: what a message carries so an agent knows where to look.
 * @param {{ root: string, folder: string, limit: number }} options
 */
export function listWorkspaceFolder({ root, folder, limit }) {
  let resolved;
  try { resolved = resolveWorkspacePath(root, folder); } catch (error) { throw pathError(error); }
  if (!resolved.stat.isDirectory()) throw new ProtocolError('invalid_params', 'path is not a folder');
  const names = readdirSync(resolved.absolute, { withFileTypes: true })
    .filter(entry => entry.name !== '.git' && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({ path: resolved.relative ? `${resolved.relative}/${entry.name}` : entry.name, kind: entry.isDirectory() ? /** @type {const} */ ('directory') : /** @type {const} */ ('file') }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.path.localeCompare(b.path));
  return { entries: names.slice(0, limit), truncated: names.length > limit, total: names.length, source: /** @type {const} */ ('listing') };
}

/**
 * Lines of the workspace's non-ignored files that hold a literal query, for the Files panel's search in files.
 * Ripgrep searches when it is installed and git grep in a repository otherwise; both honour .gitignore, skip
 * binary files and never read repository metadata. Case is ignored unless the query has a capital, each file
 * gives at most 20 lines, and a search still running when its time is up hands back what it found as truncated.
 * @param {{ root: string, env: { git?: string | null, ripgrep?: string | null, path: string }, signal: AbortSignal, query: string, limit: number, timeoutMs?: number }} options
 * @returns {Promise<{ matches: { path: string, line: number, text: string }[], truncated: boolean, source: 'ripgrep' | 'git' }>}
 */
export async function searchWorkspaceText({ root, env, signal, query, limit, timeoutMs = 10_000 }) {
  const { ripgrep, git } = env;
  // Ripgrep prints `path\0line:text` and git `path\0line\0text`; with --hidden, ripgrep reads dotfiles the way git does.
  const command = ripgrep
    ? [ripgrep, '--null', '--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--smart-case', '--hidden', '--glob', '!.git', '--sort', 'path', '--max-count', String(SEARCH_PER_FILE), '-e', query, '--', '.']
    : git ? [git, '-c', 'grep.fullName=false', '-c', 'grep.column=false', 'grep', '-z', '-n', '-I', '-F', '--no-color', '--untracked', ...(query === query.toLowerCase() ? ['-i'] : []), '-e', query] : null;
  if (!command) throw new ProtocolError('unavailable', 'searching in files needs ripgrep');
  const source = ripgrep ? 'ripgrep' : 'git';
  if (signal.aborted) throw new ProtocolError('interrupted', 'search cancelled');
  const proc = Bun.spawn(command, { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: env.path, GIT_OPTIONAL_LOCKS: '0' } });
  const stderr = (async () => { let text = ''; for await (const chunk of proc.stderr) text = (text + Buffer.from(chunk).toString('utf8')).slice(-2048); return text; })();
  const reader = proc.stdout.getReader();
  /** @type {{ path: string, line: number, text: string }[]} */
  const matches = [];
  /** @type {Map<string, number>} */
  const perFile = new Map();
  let truncated = false, stopped = false, partial = '';
  const stop = () => { stopped = true; proc.kill(); reader.cancel().catch(() => {}); };
  const timer = setTimeout(() => { truncated = true; stop(); }, timeoutMs);
  signal.addEventListener('abort', stop, { once: true });
  /** @param {string} record one output line */
  const take = record => {
    const cut = record.indexOf('\0');
    const number = cut > 0 ? /^(\d+)[:\0]/.exec(record.slice(cut + 1, cut + 24)) : null;
    if (!number || Number(number[1]) < 1) return;
    const file = record.slice(0, cut).replaceAll('\\', '/').replace(/^\.\//, '');
    if (file.split('/').some(part => part === '..' || part === '.git')) return; // never outside the workspace, never repository metadata
    const seen = perFile.get(file) ?? 0;
    if (seen >= SEARCH_PER_FILE) return;
    if (matches.length >= limit) { truncated = true; stop(); return; }
    perFile.set(file, seen + 1);
    matches.push({ path: file, line: Number(number[1]), text: record.slice(cut + 1 + number[0].length).replace(/\r$/, '').slice(0, SEARCH_TEXT_CHARS) });
  };
  try {
    const decoder = new TextDecoder();
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      let end;
      while (!stopped && (end = partial.indexOf('\n')) !== -1) { take(partial.slice(0, end)); partial = partial.slice(end + 1); }
      if (partial.length > SEARCH_LINE_HEAD) partial = partial.slice(0, SEARCH_LINE_HEAD); // a very long line keeps only its head
    }
    if (!stopped && partial) take(partial);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
  const diagnostics = await stderr;
  if (signal.aborted) throw new ProtocolError('interrupted', 'search cancelled');
  // Ripgrep exits 2 when some files could not be read; what it found in the rest still stands. Git fails outside a repository.
  if (stopped || proc.exitCode === 0 || proc.exitCode === 1 || (ripgrep && matches.length)) return { matches, truncated, source };
  throw new ProtocolError('unavailable', ripgrep ? diagnostics.trim() || 'search failed' : 'searching in files needs ripgrep');
}
