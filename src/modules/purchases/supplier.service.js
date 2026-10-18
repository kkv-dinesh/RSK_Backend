import { getDb } from '../../db/connection.js';
import { ValidationError } from '../../lib/errors.js';

export function createSupplier({ name, contact }) {
  if (!name) throw new ValidationError('name is required.');
  const db = getDb();
  const result = db.prepare('INSERT INTO suppliers (name, contact) VALUES (?, ?)').run(name, contact ?? null);
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
}

export function listSuppliers() {
  return getDb().prepare('SELECT * FROM suppliers ORDER BY name').all();
}
