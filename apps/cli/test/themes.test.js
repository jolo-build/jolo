import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createThemeStore, validateTheme, readThemeSource, MAX_THEME_BYTES } from '../src/themes/store.js';
import { BUILTIN_THEMES, COLOR_KEYS, themeColor } from '../src/themes/palettes.js';
import { executeThemeCommand, parseThemeCommand } from '../src/themes/commands.js';
import { parseArgs } from '../src/args.js';

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jolo-theme-')); directories.push(dataDir);
  return { dataDir, store: createThemeStore({ dataDir }) };
}
const document = (changes = {}) => ({ version: 1, id: 'custom', extends: 'github-dark', colors: { accent: '#abcdef' }, ...changes });

test('built-ins cover complete palettes and terminal colors keep their original behavior', () => {
  expect(BUILTIN_THEMES).toHaveLength(8);
  for (const theme of BUILTIN_THEMES.slice(1)) {
    expect(Object.keys(theme.colors)).toEqual([...COLOR_KEYS]);
    for (const color of Object.values(theme.colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  }
  for (const color of ['blue', 'yellow', 'cyan', 'green', 'magenta', 'red', 'gray']) expect(themeColor(BUILTIN_THEMES[0], color)).toBe(color);
  expect(themeColor(BUILTIN_THEMES[0], 'accent')).toBeUndefined();
  expect(themeColor(BUILTIN_THEMES[0], 'border')).toBe('gray');
});

test('listing is read-only; creation, selection, edits, and removal persist per profile', () => {
  const { dataDir, store } = fixture();
  expect(store.selected()).toBe('terminal');
  expect(store.list().themes).toHaveLength(8);
  expect(existsSync(store.directory)).toBe(false);
  const created = store.create('ocean', { from: 'github-light', colors: { accent: '#112233' } });
  expect(created.theme.colors).toMatchObject({ accent: '#112233', background: '#ffffff' });
  store.select('ocean');
  const reopened = createThemeStore({ dataDir });
  expect(reopened.selected()).toBe('ocean');
  const edited = JSON.parse(readFileSync(created.path, 'utf8'));
  edited.colors.accent = '#223344'; writeFileSync(created.path, JSON.stringify(edited));
  expect(reopened.load('ocean').colors.accent).toBe('#223344');
  expect(reopened.list().themes.at(-1).id).toBe('ocean');
  expect(createThemeStore({ dataDir: path.join(dataDir, 'other') }).selected()).toBe('terminal');
  reopened.remove('ocean');
  expect(store.selected()).toBe('terminal');
  expect(() => store.load('ocean')).toThrow('Unknown theme');
});

test('install resolves inheritance, prevents clobbering, and only replaces when requested', () => {
  const { store } = fixture();
  store.install(document());
  expect(store.load('custom').colors).toMatchObject({ accent: '#abcdef', background: '#0d1117' });
  expect(() => store.install(document({ colors: { accent: '#123456' } }))).toThrow('already installed');
  expect(store.load('custom').colors.accent).toBe('#abcdef');
  store.install(document({ colors: { accent: '#123456' } }), { force: true });
  expect(store.load('custom').colors.accent).toBe('#123456');
  expect(() => store.install(document({ id: 'github-dark' }), { force: true })).toThrow('cannot be replaced');
  expect(() => store.remove('terminal')).toThrow('cannot be removed');
});

test('untrusted themes reject traversal, control sequences, unsupported versions, and executable fields', () => {
  for (const changes of [
    { id: '../escape' }, { id: '/absolute' }, { id: '__proto__' }, { version: 2 },
    { name: '\x1b[2J' }, { colors: { accent: '\x1b[31m' } }, { colors: { typo: '#123456' } },
    { colors: [] }, { extends: 'custom' }, { extends: 'terminal' }, { script: 'run me' },
  ]) expect(() => validateTheme(document(changes))).toThrow();
});

test('malformed custom files are isolated and never corrupt the saved selection', () => {
  const { store } = fixture();
  const installed = store.install(document()); store.select('custom');
  writeFileSync(installed.path, '{');
  expect(store.list().themes).toHaveLength(8);
  expect(store.list().errors).toHaveLength(1);
  expect(() => store.select('missing')).toThrow();
  expect(store.selected()).toBe('custom');
  store.remove('custom');
  expect(store.selected()).toBe('terminal');
});

test('filenames must match IDs and oversized local documents are rejected', async () => {
  const { store } = fixture();
  const installed = store.install(document());
  writeFileSync(installed.path, JSON.stringify(document({ id: 'different' })));
  expect(() => store.load('custom')).toThrow('filename');
  writeFileSync(installed.path, ' '.repeat(MAX_THEME_BYTES + 1));
  expect(() => store.load('custom')).toThrow('64 KiB');
  await expect(readThemeSource(installed.path)).rejects.toThrow('64 KiB');
});

test('HTTPS installation handles GitHub file links and bounds streamed downloads', async () => {
  let requested = '';
  const data = await readThemeSource('https://github.com/owner/repo/blob/main/theme.json', async (url) => {
    requested = String(url); return new Response(JSON.stringify(document()));
  });
  expect(requested).toBe('https://raw.githubusercontent.com/owner/repo/main/theme.json');
  expect(data.id).toBe('custom');
  await expect(readThemeSource('https://example.com/theme.json', async () => new Response(' '.repeat(MAX_THEME_BYTES + 1)))).rejects.toThrow('64 KiB');
  await expect(readThemeSource('https://example.com/theme.json', async () => new Response('{}', { status: 404 }))).rejects.toThrow('HTTP 404');
  await expect(readThemeSource('https://example.com/theme.json', async () => new Response('<html>'))).rejects.toThrow();
});

test('remote installation rejects insecure redirects and redirect loops', async () => {
  let calls = 0;
  const downgrade = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://example.com/theme.json' } }); };
  await expect(readThemeSource('http://example.com/theme.json', downgrade)).rejects.toThrow('HTTPS');
  expect(calls).toBe(0);
  await expect(readThemeSource('https://example.com/theme.json', downgrade)).rejects.toThrow('HTTPS');
  expect(calls).toBe(1);
  await expect(readThemeSource('https://example.com/theme.json', async () => new Response(null, { status: 302, headers: { location: '/again' } }))).rejects.toThrow('Too many');
});

test('theme commands create, install, and select without starting an engine', async () => {
  const { store, dataDir } = fixture();
  const execute = (args) => executeThemeCommand(parseArgs(['theme', ...args]), store);
  const created = await execute(['create', 'ocean', '--from', 'catppuccin-latte', '--set', 'accent=#123456', '--set', 'text=#112233', '--use']);
  expect(store.selected()).toBe('ocean');
  expect(created.theme.colors).toMatchObject({ accent: '#123456', text: '#112233' });
  const file = path.join(dataDir, 'with spaces.json'); writeFileSync(file, JSON.stringify(document()));
  const parsed = parseThemeCommand(`/theme install "${file}" --use`);
  await executeThemeCommand(parsed.parsed, store);
  expect(store.selected()).toBe('custom');
  expect((await execute(['show'])).theme.id).toBe('custom');
  await expect(execute(['create', 'bad', '--from'])).rejects.toThrow('--from');
  await expect(execute(['create', 'bad', '--set', 'accent=red'])).rejects.toThrow('--set');
  await expect(execute(['use', 'terminal', 'extra'])).rejects.toThrow();
  await expect(execute(['use', 'terminal', '--wat'])).rejects.toThrow('Unknown theme option');
  await execute(['remove', 'custom']);
  expect(store.selected()).toBe('terminal');
});

test('slash parsing recognizes only the theme command and rejects unclosed quotes', () => {
  for (const text of ['/themes.json', '/theme.json', 'explain /theme']) expect(parseThemeCommand(text)).toBeNull();
  expect(parseThemeCommand(' /theme ')).toEqual({ parsed: { positional: ['theme'], flags: {} } });
  expect(parseThemeCommand(' /themes ')).toEqual({ parsed: { positional: ['theme'], flags: {} } });
  expect(parseThemeCommand('/theme install "unfinished').error).toBeTruthy();
});
