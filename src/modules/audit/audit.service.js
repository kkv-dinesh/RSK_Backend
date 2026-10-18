import { getDb } from '../../db/connection.js';

// Audit writes belong inside the same transaction as the business operation
// they describe, so a failed operation never produces a misleading audit record.
export function recordAudit(db, { userId, action, entityType, entityId, previousState, newState, reason, sourceTransaction }) {
  (db ?? getDb())
    .prepare(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, previous_state_json, new_state_json, reason, source_transaction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId ?? null,
      action,
      entityType,
      entityId != null ? String(entityId) : null,
      previousState != null ? JSON.stringify(previousState) : null,
      newState != null ? JSON.stringify(newState) : null,
      reason ?? null,
      sourceTransaction ?? null
    );
}

export function listAudit({ entityType, entityId, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (entityType) {
    clauses.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    clauses.push('entity_id = ?');
    params.push(String(entityId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  return db
    .prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params);
}

/** Paged, filterable audit trail with the acting user's name, for the Audit Logs screen. */
export function searchAudit({ entityType, entityId, action, from, to, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (entityType) { clauses.push('a.entity_type = ?'); params.push(entityType); }
  if (entityId) { clauses.push('a.entity_id = ?'); params.push(String(entityId)); }
  if (action) { clauses.push('a.action = ?'); params.push(action); }
  if (from) { clauses.push('a.created_at >= ?'); params.push(from); }
  if (to) { clauses.push('a.created_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT a.*, u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
  return {
    total,
    data: rows.map((r) => ({
      id: r.id, userId: r.user_id, userName: r.user_name, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      previousState: parse(r.previous_state_json), newState: parse(r.new_state_json), reason: r.reason,
      sourceTransaction: r.source_transaction, createdAt: r.created_at,
    })),
  };
}

export function listAuditActions() {
  return getDb().prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map((r) => r.action);
}
