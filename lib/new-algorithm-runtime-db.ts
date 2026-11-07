import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeNewAlgorithmDb } from './new-algorithm-db';

const runtime = globalThis as typeof globalThis & { __newAlgorithmDb?: Database.Database };

export function getNewAlgorithmDb(): Database.Database {
  if (!runtime.__newAlgorithmDb) {
    const filename = process.env.FLOW_NEW_ALGORITHM_DB || path.join(process.cwd(), '.flow-new-algorithm.db');
    const db = new Database(filename);
    initializeNewAlgorithmDb(db);
    runtime.__newAlgorithmDb = db;
  }
  return runtime.__newAlgorithmDb;
}
