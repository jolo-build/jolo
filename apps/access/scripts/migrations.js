// Wrangler consumes SQL files; the checked-in migration source is TypeScript.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrations } from '../migrations/index.ts';

export const migrationsDirectory = fileURLToPath(new URL('../.generated/migrations/', import.meta.url));

export function generateMigrations(directory = migrationsDirectory) {
  mkdirSync(directory, { recursive: true });
  const names = new Set(migrations.map(migration => migration.name));
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.sql') && !names.has(name)) unlinkSync(path.join(directory, name));
  }
  for (const { name, sql } of migrations) {
    const target = path.join(directory, name);
    let previous;
    try { previous = readFileSync(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== sql) writeFileSync(target, sql);
  }
  return migrations.map(migration => migration.name);
}

if (import.meta.main) console.log(`Generated ${generateMigrations().length} D1 SQL migrations in ${migrationsDirectory}`);
