import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, linkSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTIN_THEMES, COLOR_KEYS, builtinTheme } from './palettes.js';

export const MAX_THEME_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export function themeId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Theme ID must be 1–48 lowercase letters, digits, or hyphens, starting with a letter or digit.');
  return id;
}

export function validateTheme(document) {
  if (!object(document)) throw new Error('A theme must be a JSON object.');
  for (const key of Object.keys(document)) if (!['version', 'id', 'name', 'extends', 'colors'].includes(key)) throw new Error(`Unknown theme field: ${JSON.stringify(key)}`);
  if (document.version !== 1) throw new Error('Theme version must be 1.');
  const id = themeId(document.id);
  if (builtinTheme(id)) throw new Error(`Built-in theme ${id} cannot be replaced.`);
  const name = document.name ?? id;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(name)) throw new Error('Theme name must be 1–80 printable characters.');
  const base = document.extends ?? 'catppuccin-mocha';
  if (typeof base !== 'string' || !builtinTheme(base) || base === 'terminal') throw new Error('Theme extends must name a built-in color theme.');
  if (!object(document.colors)) throw new Error('Theme colors must be an object.');
  for (const [key, value] of Object.entries(document.colors)) {
    if (!COLOR_KEYS.includes(key)) throw new Error(`Unknown theme color: ${JSON.stringify(key)}`);
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Theme color ${key} must be #RRGGBB.`);
  }
  return { version: 1, id, name, extends: base, colors: { ...document.colors } };
}

function readJSON(file) {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('Theme source must be a regular JSON file.');
  if (stat.size > MAX_THEME_BYTES) throw new Error('Theme file exceeds 64 KiB.');
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > MAX_THEME_BYTES) throw new Error('Theme file exceeds 64 KiB.');
  return JSON.parse(text);
}

function writeJSON(file, value, replace = true) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Linking provides no-clobber semantics even if another installer wins the race.
    if (replace) renameSync(temporary, file); else linkSync(temporary, file);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Theme already installed; use --force to replace it.');
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function createThemeStore({ dataDir }) {
  const directory = path.join(dataDir, 'themes');
  const selectionPath = path.join(directory, '.selected.json');
  const fileFor = (id) => path.join(directory, `${themeId(id)}.json`);
  const load = (id) => {
    themeId(id);
    const builtin = builtinTheme(id);
    if (builtin) return builtin;
    let document;
    try { document = validateTheme(readJSON(fileFor(id))); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Unknown theme: ${id}`); throw error; }
    if (document.id !== id) throw new Error(`Theme ID must match its filename: ${id}.json`);
    return { ...document, colors: { ...builtinTheme(document.extends).colors, ...document.colors } };
  };
  const selected = () => {
    try { return themeId(readJSON(selectionPath).id); }
    catch (error) { if (error.code === 'ENOENT') return 'terminal'; throw error; }
  };
  const list = () => {
    const themes = BUILTIN_THEMES.map((theme) => ({ ...theme, builtin: true, path: null }));
    const errors = [];
    let files = [];
    try { files = readdirSync(directory).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of files) {
      if (file.startsWith('.') || !file.endsWith('.json')) continue;
      try {
        const id = themeId(file.slice(0, -5));
        if (builtinTheme(id)) throw new Error('Built-in theme IDs are reserved.');
        themes.push({ ...load(id), builtin: false, path: fileFor(id) });
      } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    return { themes, errors };
  };
  const select = (id) => { const theme = load(id); writeJSON(selectionPath, { id }); return theme; };
  const install = (input, { force = false } = {}) => {
    const document = validateTheme(input);
    const file = fileFor(document.id);
    writeJSON(file, document, force);
    return { theme: load(document.id), path: file };
  };
  const create = (id, { from = 'catppuccin-mocha', colors = {} } = {}) => {
    const base = load(from);
    if (from === 'terminal') throw new Error('Choose a color theme as the starting point.');
    return install({ version: 1, id, name: id, extends: builtinTheme(from) ? from : 'catppuccin-mocha', colors: { ...base.colors, ...colors } });
  };
  const remove = (id) => {
    themeId(id);
    if (builtinTheme(id)) throw new Error('Built-in themes cannot be removed.');
    // An invalid custom file can still be removed. Reset selection before removing an active file.
    statSync(fileFor(id));
    if (selected() === id) select('terminal');
    unlinkSync(fileFor(id));
  };
  return { directory, load, selected, list, select, install, create, remove };
}

/**
 * Only data is downloaded: no package managers, imports, or theme scripts.
 * @param {string} source
 * @param {(url: URL, options: RequestInit) => Promise<Response>} [fetcher]
 */
export async function readThemeSource(source, fetcher = fetch) {
  if (!/^https?:\/\//i.test(source)) return readJSON(path.resolve(source));
  let url = new URL(source);
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/');
    if (parts[3] === 'blob') { parts.splice(3, 1); url = new URL(`https://raw.githubusercontent.com${parts.join('/')}`); }
  }
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Theme downloads require an HTTPS URL without credentials.');
    const response = await fetcher(url, { signal, redirect: 'manual', headers: { Accept: 'application/json' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Theme redirect has no location.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Theme download failed (HTTP ${response.status}).`); }
    if (Number(response.headers.get('content-length')) > MAX_THEME_BYTES) { await response.body?.cancel(); throw new Error('Theme file exceeds 64 KiB.'); }
    if (!response.body) throw new Error('Theme download is empty.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_THEME_BYTES) throw new Error('Theme file exceeds 64 KiB.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  throw new Error('Too many theme download redirects.');
}
