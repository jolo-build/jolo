import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { terminalTheme } from '../src/tui/terminal-theme.js';
import { builtinTheme } from '../src/themes/palettes.js';
import { slashCommands } from '../src/tui/commands.js';

const osc = (code, color) => `\x1b]${code};${color}\x1b\\`;

test('terminal theme captures fragmented color replies, keeps early typing, and restores exact colors', async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const writes = [];
  const stdout = { isTTY: true, write: (text) => {
    writes.push(text);
    if (text.includes(';?')) {
      stdin.write('early 🌊');
      stdin.write('\x1b]10;rgb:aaaa/');
      setImmediate(() => stdin.write('bbbb/cccc\x07' + osc(11, 'rgb:1111/2222/3333')));
    }
  } };
  try {
    const canvas = await terminalTheme(stdin, stdout, {});
    expect(stdin.read().toString()).toBe('early 🌊');
    canvas.apply(builtinTheme('catppuccin-mocha'));
    expect(writes.at(-1)).toBe(osc(10, '#cdd6f4') + osc(11, '#1e1e2e'));
    const count = writes.length;
    canvas.apply(builtinTheme('catppuccin-mocha'));
    expect(writes).toHaveLength(count);
    canvas.apply(builtinTheme('github-light'));
    expect(writes.at(-1)).toBe(osc(10, '#1f2328') + osc(11, '#ffffff'));
    canvas.restore();
    expect(writes.at(-1)).toBe(osc(10, 'rgb:aaaa/bbbb/cccc') + osc(11, 'rgb:1111/2222/3333'));
    const restored = writes.length; canvas.restore();
    expect(writes).toHaveLength(restored);
  } finally { stdin.destroy(); }
});

test('terminals without color replies use default resets and keep pending input', async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const writes = [];
  const stdout = { isTTY: true, write: (text) => { writes.push(text); } };
  try {
    stdin.write('/themes');
    const canvas = await terminalTheme(stdin, stdout, {});
    expect(stdin.read().toString()).toBe('/themes');
    canvas.apply(builtinTheme('github-dark'));
    canvas.apply(builtinTheme('terminal'));
    expect(writes.at(-1)).toBe('\x1b]110\x1b\\\x1b]111\x1b\\');
  } finally { stdin.destroy(); }
});

test('non-TTY and no-color sessions never query or change terminal colors', async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const writes = [];
  try {
    for (const env of [{ NO_COLOR: '1' }, { TERM: 'dumb' }, { FORCE_COLOR: '0' }]) {
      const canvas = await terminalTheme(stdin, { isTTY: true, write: (text) => writes.push(text) }, env);
      canvas.apply(builtinTheme('github-light')); canvas.restore();
    }
    const canvas = await terminalTheme(stdin, { isTTY: false, write: (text) => writes.push(text) }, {});
    canvas.apply(builtinTheme('github-light')); canvas.restore();
    expect(writes).toEqual([]);
  } finally { stdin.destroy(); }
});

test('slash suggestions filter command names and stop once arguments begin', () => {
  expect(slashCommands('/').map((item) => item.command)).toContain('/themes');
  expect(slashCommands('/th')[0].command).toBe('/themes');
  expect(slashCommands('/theme c')).toEqual([{ command: '/theme create', description: 'Create a custom theme', arguments: true }]);
  for (const input of ['', 'explain /themes', '/model openai', '/theme create ocean', '/not-a-command']) expect(slashCommands(input)).toEqual([]);
});
