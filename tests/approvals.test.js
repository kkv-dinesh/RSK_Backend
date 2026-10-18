import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-approvals-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { requestApproval, decideApproval } = await import('../src/modules/approvals/approval.service.js');

seed();
const db = getDb();
const ownerId = db.prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const staffId = db.prepare('SELECT id FROM users WHERE username = ?').get('staff').id;

test('a requester cannot approve their own request (service-level check)', () => {
  const req = requestApproval({ actionCode: 'DISCOUNT_OVER_LIMIT', entityType: 'sale', entityId: 1, requestedBy: staffId });
  assert.throws(() => decideApproval(req.id, { decision: 'APPROVED', decidedBy: staffId, reason: 'self-approve' }), /cannot also approve/);
});

test('a requester cannot approve their own request even via a raw UPDATE (DB-level CHECK)', () => {
  const req = requestApproval({ actionCode: 'DISCOUNT_OVER_LIMIT', entityType: 'sale', entityId: 2, requestedBy: staffId });
  assert.throws(() =>
    db.prepare("UPDATE approval_requests SET status='APPROVED', decided_by=? WHERE id=?").run(staffId, req.id)
  );
});

test('a different user can approve, and the decision is recorded with reason and timestamp', () => {
  const req = requestApproval({ actionCode: 'STOCK_ADJUSTMENT_LARGE', entityType: 'inventory_item', entityId: 5, requestedBy: staffId });
  const decided = decideApproval(req.id, { decision: 'APPROVED', decidedBy: ownerId, reason: 'Verified physically' });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.decidedBy, ownerId);
  assert.ok(decided.decidedAt);
});

test('a decided request cannot be decided again', () => {
  const req = requestApproval({ actionCode: 'STOCK_ADJUSTMENT_LARGE', entityType: 'inventory_item', entityId: 6, requestedBy: staffId });
  decideApproval(req.id, { decision: 'REJECTED', decidedBy: ownerId, reason: 'Not justified' });
  assert.throws(() => decideApproval(req.id, { decision: 'APPROVED', decidedBy: ownerId }), /already been decided/);
});
