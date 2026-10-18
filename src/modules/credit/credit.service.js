import { getDb } from '../../db/connection.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { fromMinorUnits } from '../../lib/money.js';
import { getSaleOutstandingMinor } from '../sales/sale.service.js';

// DEMO ONLY overdue threshold. TODO(OWNER_POLICY): confirm what counts as
// "overdue" and the approved customer-contact channels (spec §4.8).
const DEFAULT_OVERDUE_DAYS = 30;

/** Outstanding figures here are always recomputed from the ledger/allocations — never cached. */
export function listOverdueInvoices({ overdueDays = DEFAULT_OVERDUE_DAYS } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - overdueDays * 24 * 60 * 60 * 1000).toISOString();
  const sales = db
    .prepare(
      `SELECT s.*, c.name AS customer_name FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'COMPLETED' AND s.created_at < ?`
    )
    .all(cutoff);

  return sales
    .map((s) => ({
      saleId: s.id,
      customerId: s.customer_id,
      customerName: s.customer_name,
      invoiceDate: s.created_at,
      outstanding: fromMinorUnits(getSaleOutstandingMinor(db, s.id)),
    }))
    .filter((s) => s.outstanding > 0)
    .sort((a, b) => (a.invoiceDate < b.invoiceDate ? -1 : 1));
}

export function createFollowUp({ customerId, saleId, dueDate, followUpDate, assignedTo, notes, createdBy }) {
  if (!customerId) throw new ValidationError('customerId is required.');
  const db = getDb();
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) {
    throw new NotFoundError(`Customer ${customerId} not found.`);
  }
  const result = db
    .prepare(
      `INSERT INTO credit_follow_ups (customer_id, sale_id, due_date, follow_up_date, assigned_to, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(customerId, saleId ?? null, dueDate ?? null, followUpDate ?? null, assignedTo ?? null, notes ?? null, createdBy);
  return getFollowUp(result.lastInsertRowid);
}

export function getFollowUp(id) {
  const row = getDb().prepare('SELECT * FROM credit_follow_ups WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`Follow-up ${id} not found.`);
  return row;
}

export function listFollowUpsForCustomer(customerId) {
  return getDb().prepare('SELECT * FROM credit_follow_ups WHERE customer_id = ? ORDER BY id DESC').all(customerId);
}

/** Recording an outcome only updates the worklist row — it never touches financial balances (spec §4.8). */
export function recordFollowUpOutcome(id, { outcome, notes }) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM credit_follow_ups WHERE id = ?').get(id)) {
    throw new NotFoundError(`Follow-up ${id} not found.`);
  }
  db.prepare('UPDATE credit_follow_ups SET outcome = ?, notes = COALESCE(?, notes) WHERE id = ?').run(outcome ?? null, notes ?? null, id);
  return getFollowUp(id);
}
