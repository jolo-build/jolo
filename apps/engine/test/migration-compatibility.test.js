import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { migrate, SchemaError } from '../src/storage/db.js';
import { migrations } from '../migrations/index.ts';

const legacy = migrations.find(migration => migration.version === 8).compatibleChecksums[0];
const historical = migrations.filter(migration => migration.compatibleChecksums?.length);

test.each(historical)('historical migration $version preserves its ledger and saved data', (migration) => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrations);
    db.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(migration.compatibleChecksums[0], migration.version);
    const ledger = db.query('SELECT * FROM schema_migrations ORDER BY version').all();
    db.exec("INSERT INTO projects (id, identity, root_path, created_at, updated_at) VALUES ('p', '/saved', '/saved', 'then', 'then')");
    expect(migrate(db, migrations)).toEqual({ version: migrations.at(-1).version, appliedNow: 0 });
    expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(ledger);
    expect(db.query("SELECT root_path FROM projects WHERE id = 'p'").get().root_path).toBe('/saved');
    db.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('unknown', migration.version);
    expect(() => migrate(db, migrations)).toThrow(SchemaError);
  } finally { db.close(); }
});

test('all historical checksums work together, including when later migrations are pending', () => {
  const db = new Database(':memory:');
  try {
    const older = migrations.filter(migration => migration.version <= 8);
    migrate(db, older);
    for (const migration of historical) {
      db.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(migration.compatibleChecksums[0], migration.version);
    }
    const ledger = db.query('SELECT * FROM schema_migrations ORDER BY version').all();
    expect(migrate(db, migrations)).toEqual({ version: migrations.at(-1).version, appliedNow: migrations.length - older.length });
    expect(db.query('SELECT * FROM schema_migrations WHERE version <= 8 ORDER BY version').all()).toEqual(ledger);
    expect(migrate(db, migrations).appliedNow).toBe(0);
    db.exec('ALTER TABLE projects ADD COLUMN unexpected TEXT');
    expect(() => migrate(db, migrations)).toThrow('historical migration schema differs at projects');
  } finally { db.close(); }
});

test('the known historical plan migration opens without changing its ledger or saved data', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrations);
    db.query('UPDATE schema_migrations SET checksum = ? WHERE version = 8').run(legacy);
    db.query("INSERT INTO projects (id, identity, root_path, created_at, updated_at) VALUES ('p', '/saved', '/saved', 'then', 'then')").run();
    expect(migrate(db, migrations)).toEqual({ version: migrations.at(-1).version, appliedNow: 0 });
    expect(db.query('SELECT checksum FROM schema_migrations WHERE version = 8').get().checksum).toBe(legacy);
    expect(db.query("SELECT root_path FROM projects WHERE id = 'p'").get().root_path).toBe('/saved');
  } finally { db.close(); }
});

test('an unknown changed migration or a changed historical schema is still refused', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrations);
    db.query('UPDATE schema_migrations SET checksum = ? WHERE version = 8').run(createHash('sha256').update('unknown').digest('hex'));
    expect(() => migrate(db, migrations)).toThrow(SchemaError);
    db.query('UPDATE schema_migrations SET checksum = ? WHERE version = 8').run(legacy);
    db.exec('ALTER TABLE plans ADD COLUMN unexpected TEXT');
    expect(() => migrate(db, migrations)).toThrow('historical migration schema differs at plans');
  } finally { db.close(); }
});

// Capture both histories by running their actual SQL, rather than changing a ledger on a fresh DB.
const refreshBranch = migrations.filter(migration => migration.version <= 16).map(migration => ({
  ...migration,
  ...(migration.historicalVariants?.[0] ?? {}),
}));
/** The newest schema this build migrates to. */
const latest = migrations.at(-1).version;
const histories = [
  { label: 'before version 15', source: migrations.filter(m => m.version <= 14) },
  { label: 'original version 15', source: migrations.filter(m => m.version <= 15) },
  { label: 'original version 16', source: migrations.filter(m => m.version <= 16) },
  { label: 'refresh branch version 15', source: refreshBranch.filter(m => m.version <= 15) },
  { label: 'refresh branch version 16', source: refreshBranch },
];

test.each(histories)('$label upgrades without losing saved data or rewriting its ledger', ({ source }) => {
  const db = new Database(':memory:');
  try {
    migrate(db, source);
    // Existing development profiles can have both older text aliases and the reused 15/16.
    for (const migration of historical) db.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(migration.compatibleChecksums[0], migration.version);
    db.exec(`
      INSERT INTO projects (id, identity, root_path, created_at, updated_at) VALUES ('p', '/saved', '/saved', 'then', 'then');
      INSERT INTO workspaces (id, project_id, mode, path, created_at) VALUES ('w', 'p', 'direct', '/saved', 'then');
      INSERT INTO sessions (id, project_id, workspace_id, title, created_at, updated_at) VALUES ('s', 'p', 'w', 'Saved chat', 'then', 'then');
    `);
    const columns = db.query('PRAGMA table_info(sessions)').all().map(column => column.name);
    if (columns.includes('agent_models')) db.query('UPDATE sessions SET agent_models = ?').run('{"claude":{"model":"saved-model"}}');
    if (columns.includes('pinned_at')) db.exec("UPDATE sessions SET pinned_at = 'pinned-then'");
    if (columns.includes('agent_model')) db.query('UPDATE sessions SET agent_model = ?').run('{"model":"saved-model"}');
    const session = db.query('SELECT * FROM sessions').get();
    const hadChangeEvents = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name = 'run_change_events'").get());
    if (hadChangeEvents) {
      db.exec("INSERT INTO runs (id, session_id, request_id, state, prompt, created_at, updated_at) VALUES ('r', 's', 'req', 'completed', 'Saved prompt', 'then', 'then')");
      db.query('INSERT INTO run_change_events (seq, run_id, payload) VALUES (1, ?, ?)').run('r', '{"changes":[]}');
    }
    const ledger = db.query('SELECT * FROM schema_migrations ORDER BY version').all();
    const backups = [];
    expect(migrate(db, migrations, { beforeMigrate: range => backups.push(range) })).toEqual({ version: latest, appliedNow: latest - source.length });
    expect(backups).toEqual([{ from: source.at(-1).version, to: latest }]);
    expect(db.query('SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version').all(source.at(-1).version)).toEqual(ledger);
    expect(db.query('SELECT * FROM sessions').get()).toMatchObject({ ...session, pinned_at: session.pinned_at ?? null, agent_model: session.agent_model ?? null });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'sessions_pinned'").get()).not.toBeNull();
    if (hadChangeEvents) expect(db.query('SELECT payload FROM run_change_events WHERE seq = 1').get().payload).toBe('{"changes":[]}');
    expect(migrate(db, migrations)).toEqual({ version: latest, appliedNow: 0 });
    expect(db.query('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  } finally { db.close(); }
});

test('a reused migration version still requires its exact identity and expected schema', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, refreshBranch);
    db.exec("UPDATE schema_migrations SET name = 'unknown.sql' WHERE version = 15");
    expect(() => migrate(db, migrations)).toThrow(SchemaError);
    db.exec("UPDATE schema_migrations SET name = '0015_pinned_sessions.sql' WHERE version = 15");
    db.exec('DROP INDEX sessions_pinned');
    const ledger = db.query('SELECT * FROM schema_migrations ORDER BY version').all();
    let backedUp = false;
    expect(() => migrate(db, migrations, { beforeMigrate: () => { backedUp = true; } })).toThrow('historical migration schema differs at sessions_pinned');
    expect(backedUp).toBe(false);
    expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(ledger);
  } finally { db.close(); }
});
