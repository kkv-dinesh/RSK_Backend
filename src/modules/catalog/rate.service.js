import { getDb } from '../../db/connection.js';
import { ValidationError } from '../../lib/errors.js';
import { toMinorUnits, fromMinorUnits } from '../../lib/money.js';
import { recordAudit } from '../audit/audit.service.js';

// Rate changes are append-only: a new rate is a new row, never an edit of an
// existing one, so completed transactions keep referencing the rate that
// actually applied to them (JEWELLERY_TECHNICAL_SPEC.md §4.2).
export function recordRate({ metal, purity, ratePerGram, effectiveDate, source, recordedBy }) {
  if (!metal || !purity) throw new ValidationError('metal and purity are required.');
  if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
    throw new ValidationError('ratePerGram must be a positive number.', { field: 'ratePerGram' });
  }
  if (!effectiveDate) throw new ValidationError('effectiveDate is required.');

  const db = getDb();
  const insert = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO metal_rates (metal, purity, rate_per_gram_minor, effective_date, source, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(metal, purity, toMinorUnits(ratePerGram), effectiveDate, source ?? null, recordedBy);
    recordAudit(db, {
      userId: recordedBy,
      action: 'RATE_CHANGE',
      entityType: 'metal_rate',
      entityId: result.lastInsertRowid,
      newState: { metal, purity, ratePerGram, effectiveDate, source },
      reason: source ?? null,
    });
    return result.lastInsertRowid;
  });

  const id = insert();
  return getRate(id);
}

export function getRate(id) {
  const row = getDb().prepare('SELECT * FROM metal_rates WHERE id = ?').get(id);
  return row ? toApi(row) : null;
}

export function latestRate(metal, purity) {
  const row = getDb()
    .prepare(
      `SELECT * FROM metal_rates WHERE metal = ? AND purity = ?
       ORDER BY effective_date DESC, id DESC LIMIT 1`
    )
    .get(metal, purity);
  return row ? toApi(row) : null;
}

export function listRateHistory({ metal, purity, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (metal) { clauses.push('metal = ?'); params.push(metal); }
  if (purity) { clauses.push('purity = ?'); params.push(purity); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  return db
    .prepare(`SELECT * FROM metal_rates ${where} ORDER BY effective_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params)
    .map(toApi);
}

function toApi(row) {
  return {
    id: row.id,
    metal: row.metal,
    purity: row.purity,
    ratePerGram: fromMinorUnits(row.rate_per_gram_minor),
    effectiveDate: row.effective_date,
    source: row.source,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  };
}
