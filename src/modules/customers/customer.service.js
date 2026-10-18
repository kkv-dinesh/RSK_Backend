import { getDb } from '../../db/connection.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { fromMinorUnits } from '../../lib/money.js';

export function createCustomer({ name, phone, email, address }) {
  if (!name) throw new ValidationError('name is required.');
  const db = getDb();
  const result = db
    .prepare('INSERT INTO customers (name, phone, email, address) VALUES (?, ?, ?, ?)')
    .run(name, phone ?? null, email ?? null, address ?? null);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
}

/** Each row carries its ledger-derived balance (never a stored total). */
export function listCustomers({ limit = 50, offset = 0 } = {}) {
  return getDb()
    .prepare(
      `SELECT c.*, COALESCE((SELECT SUM(amount_minor) FROM customer_ledger_entries l WHERE l.customer_id = c.id), 0) AS balance_minor
       FROM customers c ORDER BY c.name LIMIT ? OFFSET ?`
    )
    .all(limit, offset)
    .map(({ balance_minor, ...c }) => ({ ...c, balance: fromMinorUnits(balance_minor) }));
}

export function getCustomer(id) {
  const row = getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`Customer ${id} not found.`);
  return row;
}

/** The customer's balance is always SUM(amount_minor) over their ledger entries — never a stored, independently editable total. */
export function customerLedger(customerId) {
  const db = getDb();
  getCustomer(customerId);
  const entries = db
    .prepare('SELECT * FROM customer_ledger_entries WHERE customer_id = ? ORDER BY id')
    .all(customerId);
  const balanceMinor = entries.reduce((sum, e) => sum + e.amount_minor, 0);
  return {
    customerId,
    balance: fromMinorUnits(balanceMinor),
    entries: entries.map((e) => ({
      id: e.id,
      entryType: e.entry_type,
      amount: fromMinorUnits(e.amount_minor),
      sourceTransaction: e.source_transaction,
      createdAt: e.created_at,
    })),
  };
}

export function appendLedgerEntry(db, { customerId, entryType, amountMinor, sourceTransaction, createdBy }) {
  db.prepare(
    `INSERT INTO customer_ledger_entries (customer_id, entry_type, amount_minor, source_transaction, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(customerId, entryType, amountMinor, sourceTransaction, createdBy);
}
