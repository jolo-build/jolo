// Catppuccin: https://catppuccin.com/palette/
// GitHub: https://github.com/primer/github-vscode-theme (Primer colors).
const palette = (id, name, values) => Object.freeze({
  id, name, colors: Object.freeze(Object.fromEntries(
    ['background', 'surface', 'text', 'muted', 'border', 'accent', 'success', 'warning', 'error', 'keyword', 'string', 'function', 'number', 'variable']
      .map((key, index) => [key, values[index]]),
  )),
});

/** @type {ReadonlyArray<{ id: string, name: string, colors: Readonly<Record<string, string>> }>} */
export const BUILTIN_THEMES = Object.freeze([
  Object.freeze({ id: 'terminal', name: 'Terminal default', colors: Object.freeze({}) }),
  palette('catppuccin-latte', 'Catppuccin Latte', ['#eff1f5', '#e6e9ef', '#4c4f69', '#6c6f85', '#9ca0b0', '#1e66f5', '#40a02b', '#df8e1d', '#d20f39', '#8839ef', '#40a02b', '#1e66f5', '#fe640b', '#179299']),
  palette('catppuccin-frappe', 'Catppuccin Frappé', ['#303446', '#292c3c', '#c6d0f5', '#a5adce', '#737994', '#8caaee', '#a6d189', '#e5c890', '#e78284', '#ca9ee6', '#a6d189', '#8caaee', '#ef9f76', '#81c8be']),
  palette('catppuccin-macchiato', 'Catppuccin Macchiato', ['#24273a', '#1e2030', '#cad3f5', '#a5adcb', '#6e738d', '#8aadf4', '#a6da95', '#eed49f', '#ed8796', '#c6a0f6', '#a6da95', '#8aadf4', '#f5a97f', '#8bd5ca']),
  palette('catppuccin-mocha', 'Catppuccin Mocha', ['#1e1e2e', '#181825', '#cdd6f4', '#a6adc8', '#6c7086', '#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7', '#a6e3a1', '#89b4fa', '#fab387', '#94e2d5']),
  palette('github-light', 'GitHub Light', ['#ffffff', '#f6f8fa', '#1f2328', '#656d76', '#d0d7de', '#0969da', '#1a7f37', '#9a6700', '#cf222e', '#cf222e', '#0a3069', '#8250df', '#0550ae', '#953800']),
  palette('github-dark', 'GitHub Dark', ['#0d1117', '#161b22', '#e6edf3', '#7d8590', '#30363d', '#2f81f7', '#3fb950', '#d29922', '#f85149', '#ff7b72', '#a5d6ff', '#d2a8ff', '#79c0ff', '#ffa657']),
  palette('github-dark-dimmed', 'GitHub Dark Dimmed', ['#22272e', '#2d333b', '#adbac7', '#768390', '#444c56', '#539bf5', '#57ab5a', '#c69026', '#e5534b', '#f47067', '#96d0ff', '#dcbdfb', '#6cb6ff', '#f69d50']),
]);

export const COLOR_KEYS = Object.freeze(Object.keys(BUILTIN_THEMES[1].colors));
export const builtinTheme = (id) => BUILTIN_THEMES.find((theme) => theme.id === id);

// Existing markdown spans keep their portable ANSI names until they reach Ink.
export function themeColor(theme, color) {
  const role = { cyan: 'variable', blue: 'function', magenta: 'keyword', green: 'success', yellow: 'warning', red: 'error', gray: 'muted' }[color] ?? color;
  const terminal = { accent: undefined, text: undefined, background: undefined, surface: undefined, border: 'gray', muted: 'gray', success: 'green', warning: 'yellow', error: 'red', keyword: 'magenta', string: 'green', function: 'blue', number: 'yellow', variable: 'cyan' };
  return theme.colors[role] ?? (Object.hasOwn(terminal, color) ? terminal[color] : color);
}
