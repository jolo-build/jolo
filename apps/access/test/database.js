import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Adapt only D1's API; all fixtures execute the real migrations and queries.
export function testDatabase() {
  const sqlite = new Database(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...input) { values = input; return this; },
        async first() { return sqlite.query(sql).get(...values); },
        async all() { return { results: sqlite.query(sql).all(...values) }; },
        execute() { return { success: true, results: sqlite.query(sql).all(...values) }; },
        async run() { return this.execute(); },
      };
    },
    async batch(statements) { return sqlite.transaction(() => statements.map(statement => statement.execute()))(); },
  };
  return { sqlite, db };
}
