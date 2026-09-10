import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { migrate, SchemaError } from '../../apps/engine/src/storage/db.js';
import { migrations } from '../../migrations/index.js';

const legacy = migrations.find(migration => migration.version === 8).compatibleChecksums[0];
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
