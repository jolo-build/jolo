import { BUILTIN_THEMES, builtinTheme } from '@jolo/themes';

export const THEME_STORAGE_KEY = 'jolo.theme';
export const DESKTOP_THEMES = Object.freeze([
  { id: 'system', name: 'System default' },
  ...BUILTIN_THEMES.filter(theme => theme.id !== 'terminal'),
]);
const normalize = id => DESKTOP_THEMES.some(theme => theme.id === id) ? id : 'system';

export function readTheme() {
  try { return normalize(localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return 'system'; }
}

const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
const luminance = hex => rgb(hex).map(value => {
  const channel = value / 255;
  return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
}).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
const mix = (base, color, amount) => `#${rgb(base).map((channel, index) => Math.round(channel * (1 - amount) + rgb(color)[index] * amount).toString(16).padStart(2, '0')).join('')}`;

/** Adapt shared semantic colors to desktop surfaces without changing the CLI palette. */
export function themeStyle(id) {
  const theme = builtinTheme(id);
  if (!theme || theme.id === 'terminal') return {};
  const c = theme.colors;
  return {
    colorScheme: luminance(c.background) < .5 ? 'dark' : 'light',
    '--startup-bg': c.background, '--startup-text': c.text, '--startup-muted': c.muted,
    '--bg': c.background, '--panel': c.surface, '--side': c.surface,
    '--shell-border': c.border, '--border': c.border,
    '--subtle': mix(c.background, c.surface, .5),
    '--hover': mix(c.surface, c.text, .08),
    '--field': mix(c.background, c.text, .08),
    '--field-focus': mix(c.background, c.text, .14),
    '--text': c.text, '--muted': c.muted,
    '--accent': c.accent, '--on-accent': luminance(c.accent) > .179 ? '#000000' : '#ffffff',
    '--highlight': c.accent, '--tint': mix(c.background, c.accent, .15),
    '--green': c.success, '--green-bg': mix(c.background, c.success, .12),
    '--red': c.error, '--red-bg': mix(c.background, c.error, .12), '--warning': c.warning,
    '--scroll-thumb': c.border, '--scroll-thumb-hover': mix(c.border, c.text, .25), '--scroll-thumb-active': c.muted,
    '--syntax-comment': c.muted, '--syntax-keyword': c.keyword, '--syntax-string': c.string,
    '--syntax-function': c.function, '--syntax-number': c.number, '--syntax-variable': c.variable, '--syntax-punctuation': c.muted,
  };
}

const properties = Object.keys(themeStyle('catppuccin-mocha')).filter(key => key.startsWith('--'));

export function applyTheme(id = readTheme()) {
  const selected = normalize(id), root = document.documentElement;
  const style = themeStyle(selected);
  for (const property of properties) {
    if (style[property]) root.style.setProperty(property, style[property]);
    else root.style.removeProperty(property);
  }
  root.style.colorScheme = style.colorScheme ?? '';
  root.dataset.theme = selected;
  root.dataset.themeMode = style.colorScheme ?? 'system';
  // Terminals update their existing renderer; changing a theme never restarts a shell.
  window.dispatchEvent(new CustomEvent('jolo:theme', { detail: selected }));
  return selected;
}

export function saveTheme(id) {
  const selected = normalize(id);
  try { localStorage.setItem(THEME_STORAGE_KEY, selected); } catch { /* optional persistence */ }
  return applyTheme(selected);
}

/** Apply before React mounts, and follow changes from other desktop windows. */
export function initializeTheme() {
  applyTheme();
  window.addEventListener('storage', event => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) applyTheme();
  });
}

/** @returns {import('@xterm/xterm').ITheme} */
export function terminalTheme(id, dark) {
  const theme = builtinTheme(id);
  if (!theme || theme.id === 'terminal') return dark
    ? { background: '#191a1c', foreground: '#ededee', cursor: '#ededee', selectionBackground: '#282f47' }
    : { background: '#fcfcfb', foreground: '#242629', cursor: '#292c30', selectionBackground: '#edf1ff' };
  const c = theme.colors;
  return {
    background: c.background, foreground: c.text, cursor: c.text, cursorAccent: c.background,
    selectionBackground: mix(c.background, c.accent, .3),
    black: c.surface, red: c.error, green: c.success, yellow: c.warning,
    blue: c.function, magenta: c.keyword, cyan: c.variable, white: c.text,
    brightBlack: c.muted, brightRed: c.error, brightGreen: c.success, brightYellow: c.warning,
    brightBlue: c.function, brightMagenta: c.keyword, brightCyan: c.variable, brightWhite: c.text,
  };
}
