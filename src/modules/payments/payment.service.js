import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { fromMinorUnits } from '../../lib/money.js';
import { recordPaymentWithinTransaction } from '../sales/sale.service.js';
import { appendLedgerEntry } from '../customers/customer.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { normalizePaymentMethod } from '../../lib/paymentMethods.js';

export function recordPayment({ customerId, saleId, amount, method, reference, createdBy }) {
  if (!customerId) throw new ValidationError('customerId is required.');
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('amount must be a positive number.');
  const db = getDb();
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new NotFoundError(`Customer ${customerId} not found.`);
  if (saleId != null) {
    const sale = db.prepare('SELECT id FROM sales WHERE id = ?').get(saleId);
    if (!sale) throw new NotFoundError(`Sale ${saleId} not found.`);
  }

  const run = db.transaction(() =>
    recordPaymentWithinTransaction(db, {
      customerId, saleId: saleId ?? null, amountMinor: Math.round(amount * 100), method: normalizePaymentMethod(method), reference, createdBy,
    })
  );
  const paymentId = run();
  return getPayment(paymentId);
}

export function getPayment(id) {
  const row = getDb().prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`Payment ${id} not found.`);
  return toApi(row);
}

/** All payments (newest first) with customer name and the sale each one was allocated to. */
export function listPayments({ customerId, method, status, type, from, to, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (customerId) { clauses.push('p.customer_id = ?'); params.push(customerId); }
  if (method) { clauses.push('p.method = ?'); params.push(method); }
  if (status) { clauses.push('p.status = ?'); params.push(status); }
  if (type) { clauses.push('p.payment_type = ?'); params.push(type); }
  if (from) { clauses.push('p.created_at >= ?'); params.push(from); }
  if (to) { clauses.push('p.created_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM payments p ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT p.*, c.name AS customer_name,
              COALESCE((SELECT pa.sale_id FROM payment_allocations pa WHERE pa.payment_id = p.id LIMIT 1), p.refund_for_sale_id) AS sale_id
       FROM payments p JOIN customers c ON c.id = p.customer_id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return { total, data: rows.map((r) => ({ ...toApi(r), customerName: r.customer_name, saleId: r.sale_id })) };
}

export function listPaymentsForCustomer(customerId) {
  return getDb()
    .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY id DESC')
    .all(customerId)
    .map(toApi);
}

/**
 * Reverses a payment: the payment and its allocations stay in history
 * unchanged (traceable), but its ledger effect is undone with a new entry and
 * its status flips so it no longer counts toward any sale's "paid" total.
 * Requires payment.reverse permission at the route layer and cannot be
 * applied twice (status check).
 */
export function reversePayment(id, { reason, userId }) {
  if (!reason) throw new ValidationError('A reversal reason is required.');
  const db = getDb();
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!payment) throw new NotFoundError(`Payment ${id} not found.`);
  if (payment.status === 'REVERSED') throw new ConflictError('Payment has already been reversed.');

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE payments SET status = 'REVERSED', reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         reversed_by = ?, reverse_reason = ? WHERE id = ?`
    ).run(userId, reason, id);

    appendLedgerEntry(db, {
      customerId: payment.customer_id,
      entryType: 'REVERSAL',
      amountMinor: payment.amount_minor, // reinstates the debt this payment had reduced
      sourceTransaction: `PAYMENT-${id}-REVERSAL`,
      createdBy: userId,
    });

    recordAudit(db, {
      userId,
      action: 'PAYMENT_REVERSE',
      entityType: 'payment',
      entityId: id,
      previousState: { status: payment.status },
      newState: { status: 'REVERSED' },
      reason,
      sourceTransaction: `PAYMENT-${id}-REVERSAL`,
    });
  });
  run();
  return getPayment(id);
}

function toApi(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    amount: fromMinorUnits(row.amount_minor),
    method: row.method,
    reference: row.reference,
    paymentType: row.payment_type,
    status: row.status,
    createdAt: row.created_at,
    reversedAt: row.reversed_at,
    reverseReason: row.reverse_reason,
  };
}
