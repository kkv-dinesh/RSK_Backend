-- Purchases, suppliers, and the stock movement ledger (Phase 3).
-- Stock on hand must be reconcilable from movement history, never a manually
-- edited total — JEWELLERY_TECHNICAL_SPEC.md §4.5 / §6.2.

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- TODO(OWNER_POLICY): purchase pricing/charges/tax formula is not confirmed;
-- total_minor below is a backend-computed sum of item lines only (no charges
-- engine yet), clearly not a final production pricing policy.
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'CANCELLED')),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users (id),
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases (id),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items (id),
  rate_per_gram_minor INTEGER NOT NULL CHECK (rate_per_gram_minor > 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  metal_rate_id INTEGER REFERENCES metal_rates (id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items (purchase_id);

-- Append-only stock ledger. A row is never edited or deleted once written; a
-- correction is a new, opposite-signed movement referencing the original via
-- reversed_movement_id, so the original stays visible (§4.5, §6.2).
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items (id),
  movement_type TEXT NOT NULL CHECK (
    movement_type IN (
      'PURCHASE_IN', 'SALE_OUT', 'CUSTOMER_RETURN_IN', 'SUPPLIER_RETURN_OUT',
      'ADJUSTMENT', 'DAMAGE', 'TRANSFER', 'REVERSAL'
    )
  ),
  quantity_delta INTEGER NOT NULL,
  weight_delta_mg INTEGER NOT NULL,
  from_location_id INTEGER REFERENCES locations (id),
  to_location_id INTEGER REFERENCES locations (id),
  reason TEXT NOT NULL,
  source_transaction TEXT,
  reversed_movement_id INTEGER REFERENCES stock_movements (id),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements (movement_type);

-- Prevents a reversal being applied twice against the same original movement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_reversal_unique
  ON stock_movements (reversed_movement_id) WHERE reversed_movement_id IS NOT NULL;
