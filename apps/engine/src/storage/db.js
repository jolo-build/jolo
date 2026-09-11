// SQLite ownership and migrations.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

export class OwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = "OwnershipError";
    this.code = "ownership_busy";
  }
}

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
    this.code = "schema_unsupported";
  }
}

const isBusy = (error) => error?.code === "SQLITE_BUSY" || /database is locked/i.test(String(error?.message));

/**
 * Open the profile database as its exclusive owner. The returned connection must stay strongly
 * referenced for the engine's lifetime; GC finalization would release the lease.
 */
export function acquireDatabase(databasePath, { bootId, now = () => new Date().toISOString() }) {
  const db = new Database(databasePath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -4096; PRAGMA temp_store = FILE;");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS engine_boot (id INTEGER PRIMARY KEY CHECK (id = 1), boots INTEGER NOT NULL, last_boot_id TEXT NOT NULL, last_boot_at TEXT NOT NULL)");
    db.query("INSERT INTO engine_boot (id, boots, last_boot_id, last_boot_at) VALUES (1, 1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET boots = boots + 1, last_boot_id = excluded.last_boot_id, last_boot_at = excluded.last_boot_at").run(bootId, now());
    db.exec("COMMIT");
    const mode = db.query("PRAGMA locking_mode").get();
    const journal = db.query("PRAGMA journal_mode").get();
    if (mode.locking_mode !== "exclusive" || journal.journal_mode !== "wal") throw new Error(`unexpected database modes ${JSON.stringify({ mode, journal })}`);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    if (isBusy(error)) throw new OwnershipError("another engine owns this profile database");
    throw error;
  }
}

const checksum = (sql) => createHash("sha256").update(sql).digest("hex");

/**
 * Apply migrations in order; refuse databases newer than this build understands.
 * @param {any} db
 * @param {string | readonly any[]} source a migrations directory, or the list embedded in the build
 * @param {{ now?: () => string, beforeMigrate?: (range: { from: number, to: number }) => void }} [options]
 * `beforeMigrate` is called once before the first pending migration, so a caller can take a backup.
 */
export function migrate(db, source, { now = () => new Date().toISOString(), beforeMigrate = () => {} } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const known = Array.isArray(source)
    ? [...source].sort((a, b) => a.version - b.version)
    // `Array.isArray` does not tell the compiler that a frozen embedded list is gone from the
    // union, so the directory branch says what it already knows `source` to be.
    : readdirSync(/** @type {string} */ (source))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort()
      .map((name) => ({ version: Number.parseInt(name.slice(0, 4), 10), name, sql: readFileSync(path.join(/** @type {string} */ (source), name), "utf8") }));
  const applied = db.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
  const maxKnown = known.at(-1)?.version ?? 0;
  let verifyCompatibility = false;
  for (const row of applied) {
    if (row.version > maxKnown) throw new SchemaError(`database schema version ${row.version} is newer than the supported ${maxKnown}`);
    const match = known.find((m) => m.version === row.version);
    if (!match || checksum(match.sql) !== row.checksum) {
      if (!match?.compatibleChecksums?.includes(row.checksum)) throw new SchemaError(`applied migration ${row.version} does not match this build`);
      verifyCompatibility = true;
    }
  }
  if (verifyCompatibility) {
    // Only explicitly recognized historical text can reach this path. Verify its actual tables and
    // indexes against a fresh schema before accepting it, without rewriting the migration ledger.
    const expected = new Database(':memory:');
    try {
      for (const migration of known) if (applied.some(row => row.version === migration.version)) expected.exec(migration.sql);
      const actual = new Map(db.query('SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(row => [row.name, row.sql]));
      for (const row of expected.query('SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL').all()) {
        if (actual.get(row.name) !== row.sql) throw new SchemaError(`historical migration schema differs at ${row.name}`);
      }
    } finally { expected.close(); }
  }
  const pending = known.filter(migration => !applied.some(row => row.version === migration.version));
  if (applied.length && pending.length) beforeMigrate({ from: applied.at(-1).version, to: maxKnown });
  const apply = db.transaction((migration) => {
    db.exec(migration.sql);
    db.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)").run(migration.version, migration.name, checksum(migration.sql), now());
  });
  let appliedNow = 0;
  for (const migration of known) {
    if (applied.some((row) => row.version === migration.version)) continue;
    apply(migration);
    appliedNow += 1;
  }
  return { version: maxKnown, appliedNow };
}

/** Backup through the already-owned source connection, before schema changes. */
export function migrationBackup(db, databasePath, { from, to }) {
  const directory = path.join(path.dirname(databasePath), "migrations-backup");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `schema-${from}-to-${to}-${Date.now()}-${process.pid}.sqlite`);
  const temporary = `${destination}.pending`;
  db.query("VACUUM INTO ?1").run(temporary);
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, destination);
  return destination;
}
