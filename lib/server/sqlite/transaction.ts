import type Database from 'better-sqlite3';
import { ConcurrencyConflictError } from '../../application/repository';

/** Run a short write transaction guarded by the repository-wide revision. */
export function withRevision<T>(
  connection: Database.Database,
  expectedRevision: number | null,
  write: (revision: number) => T,
): { value: T; revision: number } {
  return connection.transaction(() => {
    const row = connection.prepare("SELECT revision FROM repository_meta WHERE key = 'main'").get() as { revision: number } | undefined;
    if (!row) throw new Error('repository_meta main row is missing');
    if (expectedRevision !== null && row.revision !== expectedRevision) {
      throw new ConcurrencyConflictError(expectedRevision, row.revision);
    }
    const value = write(row.revision);
    const updated = connection.prepare("UPDATE repository_meta SET revision = revision + 1 WHERE key = 'main' AND revision = ?").run(row.revision);
    if (updated.changes !== 1) {
      const actual = (connection.prepare("SELECT revision FROM repository_meta WHERE key = 'main'").get() as {revision:number}).revision;
      throw new ConcurrencyConflictError(row.revision, actual);
    }
    return { value, revision: row.revision + 1 };
  }).immediate();
}
