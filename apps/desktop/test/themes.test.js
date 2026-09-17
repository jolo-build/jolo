import { expect, test } from 'bun:test';
import { BUILTIN_THEMES } from '@jolo/themes';
import { BUILTIN_THEMES as cliThemes } from '../../cli/src/themes/palettes.js';
import { DESKTOP_THEMES, themeStyle, terminalTheme } from '../src/renderer/themes.js';

test('desktop and CLI use one palette catalog, with a native default for each client', () => {
  expect(cliThemes).toBe(BUILTIN_THEMES);
  expect(DESKTOP_THEMES.map(theme => theme.id)).toEqual(['system', ...cliThemes.slice(1).map(theme => theme.id)]);
  for (const theme of DESKTOP_THEMES.slice(1)) expect(theme).toBe(cliThemes.find(item => item.id === theme.id));
});

test('every named theme supplies syntax colors and terminal ANSI colors regardless of OS appearance', () => {
  for (const { id, colors } of BUILTIN_THEMES.slice(1)) {
    const style = themeStyle(id);
    expect(style.colorScheme).toBe(['white', 'catppuccin-latte', 'github-light'].includes(id) ? 'light' : 'dark');
    expect(style['--bg']).toBe(colors.background);
    expect(style['--syntax-keyword']).toBe(colors.keyword);
    expect(style['--syntax-string']).toBe(colors.string);
    expect(style['--green-bg']).not.toBe(style['--red-bg']);
    const terminal = terminalTheme(id, false);
    expect(terminal).toEqual(terminalTheme(id, true));
    expect(terminal.background).toBe(colors.background);
    expect(terminal.foreground).toBe(colors.text);
    expect(terminal.red).toBe(colors.error);
    expect(terminal.blue).toBe(colors.function);
    for (const [key, value] of Object.entries(style)) if (key.startsWith('--')) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test('system default and obsolete theme IDs use the native light/dark palette', () => {
  for (const id of ['system', 'terminal', 'missing', null]) {
    expect(themeStyle(id)).toEqual({});
    expect(terminalTheme(id, false).background).toBe('#fcfcfb');
    expect(terminalTheme(id, true).background).toBe('#191a1c');
  }
});
