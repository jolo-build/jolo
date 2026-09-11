import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/storage/db.js';
import { Storage } from '../src/storage/index.js';
import { migrations } from '../migrations/index.ts';

test('an existing profile is backed up before applying a new schema', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'jolo-backup-')), databasePath = path.join(home, 'state.sqlite');
  let storage;
  try {
    const old = new Database(databasePath);
    migrate(old, migrations.slice(0, -1)); old.close();
    storage = new Storage({ databasePath, artifactsDir: path.join(home, 'artifacts'), bootId: 'boot' });
    const files = readdirSync(path.join(home, 'migrations-backup'));
    expect(files).toHaveLength(1); expect(files[0].endsWith('.sqlite')).toBe(true);
    const backup = new Database(path.join(home, 'migrations-backup', files[0]), { readonly: true });
    try { expect(backup.query('SELECT MAX(version) AS version FROM schema_migrations').get().version).toBe(migrations.at(-2).version); expect(backup.query('PRAGMA integrity_check').get().integrity_check).toBe('ok'); }
    finally { backup.close(); }
    expect(storage.schema.version).toBe(migrations.at(-1).version);
  } finally { storage?.close(); rmSync(home, { recursive: true, force: true }); }
});
