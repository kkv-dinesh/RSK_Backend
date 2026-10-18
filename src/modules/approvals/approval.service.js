import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { recordAudit } from '../audit/audit.service.js';

// Generic approval primitive for sensitive operations. TODO(OWNER_POLICY):
// which specific operations require approval and at what threshold is not
// confirmed (spec §4.10) — this module provides the enforced
// requester-cannot-equal-approver mechanism for whichever ones end up wired
// to it.
export function requestApproval({ actionCode, entityType, entityId, payload, requestedBy }) {
  if (!actionCode || !entityType) throw new ValidationError('actionCode and entityType are required.');
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO approval_requests (action_code, entity_type, entity_id, payload_json, requested_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(actionCode, entityType, entityId != null ? String(entityId) : null, payload != null ? JSON.stringify(payload) : null, requestedBy);
  return getApproval(result.lastInsertRowid);
}

export function getApproval(id) {
  const row = getDb().prepare('SELECT * FROM approval_requests WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`Approval request ${id} not found.`);
  return toApi(row);
}

export function listApprovals({ status, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  return db.prepare(`SELECT * FROM approval_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params).map(toApi);
}

/**
 * Decides a pending approval. Enforced requester/approver separation: the
 * DB-level CHECK constraint on approval_requests also rejects this, but we
 * check first here to return a clear domain error.
 */
export function decideApproval(id, { decision, decidedBy, reason }) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ValidationError('decision must be APPROVED or REJECTED.');
  const db = getDb();
  const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id);
  if (!request) throw new NotFoundError(`Approval request ${id} not found.`);
  if (request.status !== 'PENDING') throw new ConflictError(`Approval request ${id} has already been decided.`);
  if (request.requested_by === decidedBy) {
    throw new ConflictError('The requester cannot also approve their own request.');
  }

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE approval_requests SET status = ?, decided_by = ?, decision_reason = ?,
         decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(decision, decidedBy, reason ?? null, id);
    recordAudit(db, {
      userId: decidedBy, action: 'APPROVAL_DECIDE', entityType: 'approval_request', entityId: id,
      previousState: { status: 'PENDING' }, newState: { status: decision }, reason,
    });
  });
  run();
  return getApproval(id);
}

function toApi(row) {
  return {
    id: row.id,
    actionCode: row.action_code,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    requestedBy: row.requested_by,
    status: row.status,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
