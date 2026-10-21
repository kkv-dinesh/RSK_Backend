import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-backup-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createCustomer } = await import('../src/modules/customers/customer.service.js');
const { createBackup, restoreBackup, validateBackupFile } = await import('../src/modules/backup/backup.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const customerCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM customers').get().n;

test('a backup restores the data exactly as it was, undoing later changes', async () => {
  createCustomer({ name: 'Before Backup' });
  const { file } = await createBackup();
  const snapshot = fs.readFileSync(file);
  fs.rmSync(file);
  const kept = customerCount();

  createCustomer({ name: 'After Backup' });
  assert.equal(customerCount(), kept + 1);

  const result = await restoreBackup(snapshot, { userId: ownerId });
  assert.equal(result.restored, true);
  assert.equal(customerCount(), kept, 'rows added after the backup are gone');
  assert.ok(fs.existsSync(path.join(process.env.RSK_DATA_DIR, result.safetyCopy)), 'a safety copy of the replaced data is kept');
  assert.ok(getDb().prepare("SELECT 1 FROM permissions WHERE code = 'backup.manage'").get(), 'permissions are re-synced after a restore');
});

test('files that are not valid RSK backups are rejected and leave the data untouched', async () => {
  const before = customerCount();
  await assert.rejects(() => restoreBackup(Buffer.from('this is not a database at all'), { userId: ownerId }), /not an RSK backup/);
  await assert.rejects(() => restoreBackup(Buffer.alloc(0), { userId: ownerId }), /No backup file/);

  const other = path.join(process.env.RSK_DATA_DIR, 'other.sqlite3');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(other);
  db.exec('CREATE TABLE unrelated (id INTEGER)');
  db.close();
  assert.throws(() => validateBackupFile(other), /not an RSK backup/);
  await assert.rejects(() => restoreBackup(fs.readFileSync(other), { userId: ownerId }), /not an RSK backup/);
  assert.equal(customerCount(), before);
});
