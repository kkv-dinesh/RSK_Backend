import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DEV/TEST persistence only. TODO(ON_PREM_DB): replace with the approved
// on-premises database engine before any production deployment — see
// ON_PREM_MIGRATION.md for the documented switch-over plan.
const DATA_DIR = process.env.RSK_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.RSK_DB_PATH || path.join(DATA_DIR, 'rsk.sqlite3');

let instance = null;

export function getDb() {
  if (instance) return instance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  instance = new Database(DB_PATH);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  return instance;
}

export function closeDb() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function dbPath() {
  return DB_PATH;
}
