import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDb, closeDb, dbPath } from '../../db/connection.js';
import { runMigrations, MIGRATIONS_DIR } from '../../db/migrate.js';
import { ValidationError } from '../../lib/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { syncAccessControl } from '../../db/seed/run.js';

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const REQUIRED_TABLES = ['schema_migrations', 'users', 'roles', 'permissions', 'sales', 'purchases', 'inventory_items'];
const KEEP_SAFETY_COPIES = 5;

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** Writes a consistent snapshot of the live database to a temp file and returns its path and download name. */
export async function createBackup() {
  const file = path.join(os.tmpdir(), `rsk-backup-${process.pid}-${Date.now()}.sqlite3`);
  await getDb().backup(file);
  return { file, filename: `rsk-backup-${stamp()}.sqlite3` };
}

/** Throws a ValidationError unless `file` is a healthy RSK database this server version can use. */
export function validateBackupFile(file) {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(16);
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (header.toString('latin1') !== SQLITE_MAGIC) {
    throw new ValidationError('This is not an RSK backup file.');
  }

  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new ValidationError('The backup file is damaged and cannot be restored.');
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new ValidationError('This file is not an RSK backup (missing its business tables).');

    const known = new Set(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')));
    const unknown = db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id).filter((id) => !known.has(id));
    if (unknown.length) throw new ValidationError('This backup was made by a newer version of the app. Update the server first.');
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('This file could not be read as an RSK backup.');
  } finally {
    db?.close();
  }
}

/**
 * Replaces the live database with the uploaded backup. The file is validated
 * first, and a safety copy of the current data is kept so a wrong restore can
 * itself be undone. Older backups are brought up to date by the migrations.
 */
export async function restoreBackup(buffer, { userId } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ValidationError('No backup file was received.');

  const dir = path.dirname(dbPath());
  fs.mkdirSync(dir, { recursive: true });
  const incoming = path.join(dir, `restore-incoming-${Date.now()}.sqlite3`);
  fs.writeFileSync(incoming, buffer);

  try {
    validateBackupFile(incoming);
  } catch (err) {
    fs.rmSync(incoming, { force: true });
    throw err;
  }

  const safetyCopy = path.join(dir, `pre-restore-${stamp()}.sqlite3`);
  await getDb().backup(safetyCopy);

  closeDb();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath()}${suffix}`, { force: true });
  fs.renameSync(incoming, dbPath());
  const results = runMigrations(); // reopens the database and upgrades an older backup
  syncAccessControl(); // an older backup may predate newer permissions

  // Keep only the most recent safety copies.
  fs.readdirSync(dir).filter((f) => f.startsWith('pre-restore-')).sort().reverse().slice(KEEP_SAFETY_COPIES)
    .forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));

  // The acting user may not exist in the restored data; only log when they do.
  const db = getDb();
  if (userId != null && db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
    recordAudit(db, { userId, action: 'BACKUP_RESTORE', entityType: 'system', newState: { migrationsApplied: results.filter((r) => r.status === 'applied').length } });
  }
  return { restored: true, safetyCopy: path.basename(safetyCopy), bytes: buffer.length };
}
