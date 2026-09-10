// Typefaces: bundled defaults with a per-viewer override kept in localStorage (§4.1). A wrong name
// never breaks the app because the bundled face and the system stack stay behind it as fallbacks.
export const FONT_DEFAULTS = Object.freeze({ sans: "Inter", mono: "JetBrains Mono", terminal: "JetBrainsMono Nerd Font Mono" });
const FALLBACK = Object.freeze({
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  terminal: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
});
const STORAGE_KEY = "jolo.fonts";
const LOAD_TIMEOUT_MS = 1_500;

const cleanName = (value) => String(value ?? "").replace(/["';{}\\\n\r]/g, "").trim().slice(0, 80);
const quote = (name) => (/^[A-Za-z][\w-]*$/.test(name) ? name : `"${name}"`);
const sanitize = (fonts) => Object.fromEntries(Object.keys(FONT_DEFAULTS).map((kind) => [kind, cleanName(fonts?.[kind]) || FONT_DEFAULTS[kind]]));

export function readFonts() {
  try { return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")); } catch { return { ...FONT_DEFAULTS }; }
}

/** The CSS stack for one role: the chosen face, then the bundled one, then the system fallback. */
export function stackFor(kind, fonts = readFonts()) {
  const name = fonts[kind] || FONT_DEFAULTS[kind];
  const parts = [quote(name)];
  if (name !== FONT_DEFAULTS[kind]) parts.push(quote(FONT_DEFAULTS[kind]));
  parts.push(FALLBACK[kind]);
  return parts.join(", ");
}

export function applyFonts(fonts = readFonts()) {
  const root = document.documentElement.style;
  root.setProperty("--sans", stackFor("sans", fonts));
  root.setProperty("--mono", stackFor("mono", fonts));
  root.setProperty("--terminal-font", stackFor("terminal", fonts));
  return fonts;
}

export function saveFonts(fonts) {
  const clean = sanitize(fonts);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* optional persistence */ }
  applyFonts(clean);
  window.dispatchEvent(new CustomEvent("jolo:fonts", { detail: clean }));
  return clean;
}

/**
 * Wait for a role's face before anything measures glyphs (the terminal grid, in particular). A system font
 * resolves at once; a bundled face loads from disk; an unknown name gives up after a short timeout.
 */
export async function ensureFontLoaded(kind, fonts = readFonts()) {
  const name = fonts[kind] || FONT_DEFAULTS[kind];
  const load = (family) => document.fonts.load(`12px ${quote(family)}`).catch(() => []);
  const pending = Promise.all([load(name), name === FONT_DEFAULTS[kind] ? null : load(FONT_DEFAULTS[kind])]);
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))]);
}
