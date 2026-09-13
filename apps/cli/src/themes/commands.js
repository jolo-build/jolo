import { resolvePaths } from '@jolo/launcher';
import { parseArgs } from '../args.js';
import { createThemeStore, readThemeSource } from './store.js';

export const THEME_USAGE = 'theme list | show [id] | use <id> | create <id> [--from <id>] [--set color=#RRGGBB] | install <file-or-https-url> [--force] [--use] | remove <id>';

export function parseThemeCommand(text) {
  if (!/^\/themes?(?:\s|$)/.test(text.trim())) return null;
  // Quoted local paths work without involving a shell or evaluating escapes.
  const tokens = [];
  const pattern = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  const input = text.trim().slice(1);
  let end = 0;
  for (;;) {
    const match = pattern.exec(input);
    if (!match) break;
    tokens.push(match[1] ?? match[2] ?? match[3]); end = pattern.lastIndex;
  }
  if (end !== input.length) return { error: 'Unclosed quote in theme command.' };
  tokens[0] = 'theme';
  return { parsed: parseArgs(tokens) };
}

export async function executeThemeCommand({ positional, flags }, store) {
  const [, action = 'list', id, ...extra] = positional;
  const allowed = { list: [], show: [], use: [], create: ['from', 'set', 'use'], install: ['force', 'use'], remove: [] }[action];
  if (!allowed || extra.length || (action === 'list' && id) || (!['list', 'show'].includes(action) && !id)) throw new Error(THEME_USAGE);
  for (const flag of Object.keys(flags)) if (!['home', 'profile', 'json', ...allowed].includes(flag)) throw new Error(`Unknown theme option: --${flag}`);
  if (action === 'list') {
    const result = { selected: store.selected(), ...store.list(), directory: store.directory };
    return { ...result, message: result.themes.map((theme) => `${theme.id === result.selected ? '* ' : '  '}${theme.id} — ${theme.name}${theme.builtin ? '' : ' (installed)'}`).concat(result.errors.map((error) => `Skipped ${error}`)).join('\n') };
  }
  if (action === 'show') {
    const theme = store.load(id ?? store.selected());
    return { theme, message: JSON.stringify(theme, null, 2) };
  }
  if (action === 'use') {
    const theme = store.select(id);
    return { theme, message: `Theme: ${theme.name}` };
  }
  if (action === 'remove') { store.remove(id); return { message: `Removed theme ${id}.` }; }
  let result;
  if (action === 'create') {
    if (flags.from !== undefined && typeof flags.from !== 'string') throw new Error('--from needs one theme ID.');
    const colors = {};
    for (const entry of flags.set === undefined ? [] : Array.isArray(flags.set) ? flags.set : [flags.set]) {
      if (typeof entry !== 'string' || !/^[a-z]+=#[0-9a-f]{6}$/i.test(entry)) throw new Error('--set needs color=#RRGGBB.');
      const [key, value] = entry.split('='); colors[key] = value;
    }
    result = store.create(id, { from: flags.from, colors });
  } else result = store.install(await readThemeSource(id), { force: flags.force === true });
  if (flags.use) store.select(result.theme.id);
  return { ...result, message: `${action === 'create' ? 'Created' : 'Installed'} ${result.theme.name}: ${result.path}${flags.use ? ' · selected' : ''}` };
}

export async function commandTheme(parsed) {
  const store = createThemeStore(resolvePaths({ home: parsed.flags.home, profile: parsed.flags.profile }));
  const result = await executeThemeCommand(parsed, store);
  process.stdout.write(`${parsed.flags.json ? JSON.stringify(result) : result.message}\n`);
  return 0;
}
