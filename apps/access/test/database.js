import { Database } from 'bun:sqlite';
import { migrations } from '../migrations/index.ts';

// Adapt only D1's API; all fixtures execute the real migrations and queries.
export function testDatabase() {
  const sqlite = new Database(':memory:');
  for (const { sql } of migrations) sqlite.exec(sql);
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
