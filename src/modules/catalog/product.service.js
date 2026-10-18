import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';

export function createProduct({ designNo, category, metal, purity, description }) {
  if (!designNo || !category || !metal || !purity) {
    throw new ValidationError('designNo, category, metal, and purity are required.');
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM product_designs WHERE design_no = ?').get(designNo);
  if (existing) throw new ConflictError(`Design number "${designNo}" already exists.`);

  const result = db
    .prepare('INSERT INTO product_designs (design_no, category, metal, purity, description) VALUES (?, ?, ?, ?, ?)')
    .run(designNo, category, metal, purity, description ?? null);
  return getProduct(result.lastInsertRowid);
}

export function getProduct(id) {
  const row = getDb().prepare('SELECT * FROM product_designs WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`Product design ${id} not found.`);
  return toApi(row);
}

export function listProducts({ category, metal, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (category) { clauses.push('category = ?'); params.push(category); }
  if (metal) { clauses.push('metal = ?'); params.push(metal); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = db.prepare(`SELECT * FROM product_designs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params);
  return rows.map(toApi);
}

export function updateProduct(id, patch) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM product_designs WHERE id = ?').get(id);
  if (!existing) throw new NotFoundError(`Product design ${id} not found.`);

  const next = {
    category: patch.category ?? existing.category,
    metal: patch.metal ?? existing.metal,
    purity: patch.purity ?? existing.purity,
    description: patch.description ?? existing.description,
  };
  db.prepare(
    `UPDATE product_designs SET category = ?, metal = ?, purity = ?, description = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  ).run(next.category, next.metal, next.purity, next.description, id);
  return getProduct(id);
}

function toApi(row) {
  return {
    id: row.id,
    designNo: row.design_no,
    category: row.category,
    metal: row.metal,
    purity: row.purity,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
