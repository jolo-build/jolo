import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateMigrations } from '../scripts/migrations.js';
import { migrations } from '../migrations/index.ts';
import { Database } from 'bun:sqlite';

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
    expect(generateMigrations(directory)).toEqual(migrations.map(migration => migration.name));
    expect(readdirSync(directory).sort()).toEqual(migrations.map(migration => migration.name));
    for (const { name, checksum } of released) {
      expect(createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')).toBe(checksum);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Google migration preserves existing accounts, sessions, devices, teams and tasks', () => {
  const db = new Database(':memory:');
  try {
    for (const { sql } of migrations.slice(0, 4)) db.exec(sql);
    db.exec(`INSERT INTO accounts VALUES ('old-account','12345','old@example.com','Old account',1,1);
      INSERT INTO sessions VALUES ('session','old-account','csrf',9999999999999,1);
      INSERT INTO devices (id,token_hash,account_id,name,created_at,expires_at) VALUES ('device','device-token','old-account','Laptop',1,9999999999999);
      INSERT INTO teams (id,owner_id,name,created_at,updated_at) VALUES ('team','old-account','Existing team',1,1);
      INSERT INTO tasks (account_id,team_id,title,request_id,mutation_id,created_at,updated_at) VALUES ('old-account','team','Existing task','request','mutation',1,1);
      INSERT INTO login_flows (token_hash,state,verifier,expires_at) VALUES ('flow','state','verifier',9999999999999);`);
    db.exec(migrations[4].sql);
    expect(db.query('SELECT id, provider, provider_key FROM accounts').get()).toEqual({ id: 'old-account', provider: 'github', provider_key: 'github:12345' });
    expect(db.query('SELECT provider FROM login_flows').get().provider).toBe('github');
    for (const table of ['sessions', 'devices', 'teams', 'tasks']) expect(db.query(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(1);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
});
