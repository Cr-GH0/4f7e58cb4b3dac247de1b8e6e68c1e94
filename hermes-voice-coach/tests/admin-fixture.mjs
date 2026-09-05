import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Exercise the production SQL against real SQLite, without touching application data.
export function testDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_giant_nighthawk.sql', import.meta.url), 'utf8'));
  return { prepare(sql) {
    let args = [];
    const statement = { bind(...values) { args = values; return statement; }, async first() { return db.prepare(sql).get(...args) ?? null; } };
    return statement;
  }, close() { db.close(); } };
}
