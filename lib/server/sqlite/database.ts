import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type SqliteDatabase = BetterSQLite3Database<typeof schema>;

/** Open one SQLite connection, enable referential integrity, and apply checked-in migrations. */
export function openSqliteDatabase(filename: string): { connection: Database.Database; db: SqliteDatabase } {
  const connection = new Database(filename);
  connection.pragma('foreign_keys = ON');
  connection.pragma('journal_mode = WAL');
  connection.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const applied = new Set((connection.prepare('SELECT name FROM schema_migrations').all() as Array<{name:string}>).map(x => x.name));
  const migrationDirectory = path.join(process.cwd(), 'lib', 'server', 'sqlite', 'migrations');
  const migrations = fs.readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(migrationDirectory, name), 'utf8');
    connection.transaction(() => {
      connection.exec(sql);
      connection.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
    })();
  }
  connection.prepare("INSERT OR IGNORE INTO repository_meta(key, revision) VALUES ('main', 0)").run();
  return { connection, db: drizzle(connection, { schema }) };
}

