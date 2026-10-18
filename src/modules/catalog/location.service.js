import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError } from '../../lib/errors.js';

export function createLocation({ name, type = 'SHOWCASE' }) {
  if (!name) throw new ValidationError('name is required.');
  const db = getDb();
  if (db.prepare('SELECT id FROM locations WHERE name = ?').get(name)) {
    throw new ConflictError(`Location "${name}" already exists.`);
  }
  const result = db.prepare('INSERT INTO locations (name, type) VALUES (?, ?)').run(name, type);
  return getDb().prepare('SELECT * FROM locations WHERE id = ?').get(result.lastInsertRowid);
}

export function listLocations() {
  return getDb().prepare('SELECT * FROM locations ORDER BY name').all();
}

export function findLocationByName(name) {
  return getDb().prepare('SELECT * FROM locations WHERE name = ?').get(name);
}
