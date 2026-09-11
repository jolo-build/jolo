// Remembers the last update check so a client can mention a new release without
// asking the network on every launch. Purely advisory: a missing, stale or damaged
// file only means "check again", never an error the user has to deal with.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ file: string, ttlMs?: number, retryMs?: number, now?: () => number }} options
 */
export function createUpdateCache({ file, ttlMs = DAY_MS, retryMs = 60 * 60 * 1000, now = Date.now }) {
  function read() {
    try {
      const entry = JSON.parse(readFileSync(file, "utf8"));
      return entry?.version === 1 && Number.isFinite(entry.checkedAt) ? entry : null;
    } catch { return null; } // absent or damaged: the caller simply checks again
  }
  return {
    read,
    /** True when no recent check is on record. A failed check is retried sooner than a successful one. */
    due() {
      const entry = read();
      if (!entry) return true;
      const age = now() - entry.checkedAt;
      return age < 0 || age > (entry.failed ? retryMs : ttlMs);
    },
    /** Record an outcome. Writing is best-effort; a read-only profile must not break a check. */
    record(result) {
      const entry = { version: 1, checkedAt: now(), ...(result?.failed ? { failed: true } : { current: result.current, latest: result.latest, available: Boolean(result.available) }) };
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(temporary, `${JSON.stringify(entry)}\n`);
        renameSync(temporary, file);
      } catch { rmSync(temporary, { force: true }); }
      return entry;
    },
  };
}
