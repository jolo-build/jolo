// When did the code on disk last change?
//
// In development the engine is a long-lived process started from the source tree, and it keeps running while
// that tree is edited, so it can answer with code older than the code on disk. It cannot notice this about
// itself. This is the measurement the desktop compares against the engine's start time before asking it to
// reload; the decision of whether reloading is safe belongs to the engine, which alone knows what is in
// flight. Only meaningful when running from source: a packaged app carries its engine inside the bundle.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", "dist", ".git", "smoke-results", "results", "out", "coverage"]);
const MAX_ENTRIES = 4_000; // a bound, so a stray directory cannot turn a startup check into a tree walk

/**
 * The newest modification time under these directories, in milliseconds, or null when none can be read.
 * @param {string[]} roots
 */
export function newestSourceTime(roots) {
  let newest = null;
  let seen = 0;
  const visit = (directory) => {
    if (seen >= MAX_ENTRIES) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= MAX_ENTRIES) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!/\.(js|mjs|cjs|jsx|json|sql)$/.test(entry.name)) continue;
      seen += 1;
      try {
        const at = statSync(full).mtimeMs;
        if (newest === null || at > newest) newest = at;
      } catch { /* vanished between listing and stat */ }
    }
  };
  for (const root of roots) visit(root);
  return newest;
}
