-- Catalog, physical items, locations, and metal rate history (Phase 2).
-- Weights are stored as INTEGER milligrams and money as INTEGER minor units
-- (paise) — never raw floats — per JEWELLERY_TECHNICAL_SPEC.md §6.1.
-- TODO(OWNER_POLICY): status enum and stock-tracking granularity below are
-- engineering defaults — see BUSINESS_RULES.md.

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'SHOWCASE',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS product_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_no TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  metal TEXT NOT NULL,
  purity TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Uniquely tagged physical items. Created only via a stock-in movement
-- (Phase 3 purchase flow) so every item's existence has a traceable source.
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT NOT NULL UNIQUE,
  design_id INTEGER REFERENCES product_designs (id),
  category TEXT NOT NULL,
  metal TEXT NOT NULL,
  purity TEXT NOT NULL,
  gross_weight_mg INTEGER NOT NULL CHECK (gross_weight_mg >= 0),
  stone_weight_mg INTEGER NOT NULL DEFAULT 0 CHECK (stone_weight_mg >= 0),
  net_weight_mg INTEGER NOT NULL CHECK (net_weight_mg >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'g',
  status TEXT NOT NULL DEFAULT 'IN_STOCK'
    CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'ON_HOLD', 'DAMAGED', 'TRANSFERRED', 'REMOVED')),
  location_id INTEGER REFERENCES locations (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (net_weight_mg <= gross_weight_mg),
  CHECK (stone_weight_mg <= gross_weight_mg)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_status ON inventory_items (status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_design ON inventory_items (design_id);

-- Historical rate snapshots. Never updated in place — a rate change inserts a
-- new row, so completed transactions can keep referencing the rate that applied.
CREATE TABLE IF NOT EXISTS metal_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metal TEXT NOT NULL,
  purity TEXT NOT NULL,
  rate_per_gram_minor INTEGER NOT NULL CHECK (rate_per_gram_minor > 0),
  effective_date TEXT NOT NULL,
  source TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_metal_rates_lookup ON metal_rates (metal, purity, effective_date);
