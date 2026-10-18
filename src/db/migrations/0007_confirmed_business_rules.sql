-- Confirmed owner business rules (2026-10-18) — see conversation record.
-- Supersedes the DEMO ONLY placeholders from earlier migrations for: making
-- charges, wastage, supplier payments, and customer payment methods.

-- Wastage is a manual, editable charge per sale line (confirmed rule #1),
-- entered separately from the metal value / making charge / stone charge.
ALTER TABLE sale_items ADD COLUMN wastage_charge_minor INTEGER NOT NULL DEFAULT 0 CHECK (wastage_charge_minor >= 0);

-- Supplier payments are made in full, immediately, at the time of purchase;
-- there is no supplier credit or outstanding-supplier-balance concept in
-- scope (confirmed rule #4). Method is restricted to the four confirmed
-- customer/supplier payment methods (confirmed rule #5).
CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
  purchase_id INTEGER NOT NULL REFERENCES purchases (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL DEFAULT 'CASH' CHECK (method IN ('CASH', 'UPI', 'CARD', 'CHEQUE')),
  reference TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_purchase ON supplier_payments (purchase_id);
