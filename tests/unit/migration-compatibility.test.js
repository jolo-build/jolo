import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { migrate, SchemaError } from '../../apps/engine/src/storage/db.js';
import { migrations } from '../../migrations/index.ts';

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
