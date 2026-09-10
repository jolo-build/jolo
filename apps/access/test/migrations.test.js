import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateMigrations } from '../scripts/migrations.js';

// D1 remembers these released filenames. Their SQL must remain byte-for-byte identical.
const released = [
  {
    "name": "0001_accounts.sql",
    "checksum": "7f622dbb4c0cde0e278e03123b2cfa85fd3f1186c06c10a7c9aef00c779e8ca8"
  },
  {
    "name": "0002_devices.sql",
    "checksum": "08c9833a38ac00e8477230ccde1756580acc2fa7331df21ddff81299c805e027"
  },
  {
    "name": "0003_tasks_teams.sql",
    "checksum": "6d8bd6ca80f682a899ae1fb2e01c26e7969b03f7c6ced294c6e58a72dc48399b"
  }
];

test('TypeScript migrations generate the original D1 filenames and SQL checksums', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'access-migrations-'));
  try {
    expect(generateMigrations(directory)).toEqual(released.map(migration => migration.name));
    expect(readdirSync(directory).sort()).toEqual(released.map(migration => migration.name));
    for (const { name, checksum } of released) {
      expect(createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')).toBe(checksum);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
