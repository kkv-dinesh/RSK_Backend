-- Orders and fulfilment (Phase 6).
-- TODO(OWNER_POLICY): exact order stages, stock reservation timing, and
-- order-to-sale linkage rules are not confirmed — see BUSINESS_RULES.md.
-- An order is explicitly NOT a completed sale; sale_id is only set once a
-- separate, deliberate action links a real invoice to this order (spec §4.6).

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'READY', 'DELIVERED', 'COMPLETED', 'ON_HOLD', 'CANCELLED')
  ),
  advance_minor INTEGER NOT NULL DEFAULT 0 CHECK (advance_minor >= 0),
  expected_delivery_date TEXT,
  sale_id INTEGER REFERENCES sales (id),
  held_from_status TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  design_id INTEGER REFERENCES product_designs (id),
  inventory_item_id INTEGER REFERENCES inventory_items (id),
  description TEXT NOT NULL,
  estimated_weight_mg INTEGER,
  estimated_amount_minor INTEGER
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

-- Append-only transition history: who changed the order's status, when, and why.
CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history (order_id);
