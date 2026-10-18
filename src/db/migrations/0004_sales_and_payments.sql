-- Customers, sales, payments, allocations, and the customer ledger (Phase 4/5).
-- Balances must be derivable from ledger entries and allocations, never a
-- manually edited total (spec §4.7, §6.2).
-- TODO(OWNER_POLICY): making-charge/stone-charge/discount/tax formulas below
-- are DEMO ONLY engineering defaults — see BUSINESS_RULES.md.

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'CANCELLED')),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users (id),
  cancel_reason TEXT,
  CHECK (discount_minor <= subtotal_minor)
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales (id),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items (id),
  metal_rate_id INTEGER REFERENCES metal_rates (id),
  rate_per_gram_minor INTEGER NOT NULL CHECK (rate_per_gram_minor > 0),
  net_weight_mg INTEGER NOT NULL CHECK (net_weight_mg >= 0),
  metal_value_minor INTEGER NOT NULL CHECK (metal_value_minor >= 0),
  making_charge_minor INTEGER NOT NULL DEFAULT 0 CHECK (making_charge_minor >= 0),
  stone_charge_minor INTEGER NOT NULL DEFAULT 0 CHECK (stone_charge_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  returned_at TEXT,
  returned_by INTEGER REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL DEFAULT 'CASH',
  reference TEXT,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('ADVANCE', 'FULL', 'PARTIAL', 'SETTLEMENT', 'REFUND')),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'REVERSED')),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reversed_at TEXT,
  reversed_by INTEGER REFERENCES users (id),
  reverse_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments (customer_id);

-- A payment amount can be split across invoices, but the sum of a payment's
-- allocations can never exceed that payment's amount (checked in the service
-- layer inside the same transaction as the insert).
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments (id),
  sale_id INTEGER NOT NULL REFERENCES sales (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_sale ON payment_allocations (sale_id);

-- Append-only customer ledger. Balance = SUM(amount_minor) for the customer.
-- Positive amounts increase what the customer owes (invoices); negative
-- amounts decrease it (payments). Never updated or deleted once written.
CREATE TABLE IF NOT EXISTS customer_ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('INVOICE', 'PAYMENT', 'ADJUSTMENT', 'REVERSAL')),
  amount_minor INTEGER NOT NULL,
  source_transaction TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger_entries (customer_id);

-- Credit reminder worklist. Amounts are never stored here as authoritative —
-- always re-derived from customer_ledger_entries at read time (spec §4.8).
CREATE TABLE IF NOT EXISTS credit_follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  sale_id INTEGER REFERENCES sales (id),
  due_date TEXT,
  follow_up_date TEXT,
  assigned_to INTEGER REFERENCES users (id),
  notes TEXT,
  outcome TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_credit_follow_ups_customer ON credit_follow_ups (customer_id);
