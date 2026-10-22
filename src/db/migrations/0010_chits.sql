-- Gold savings chits. A customer pays whatever amount they choose each month
-- (monthly_amount is only the usual/suggested figure); every payment
-- is converted to gold weight at the rate applicable on the actual payment date
-- (weight = amount / rate), so there is no bonus month and a missed month is
-- simply a month without a payment row. The chit ends either in a jewellery
-- redemption or a cancellation settled in gold or cash.
-- Weights are INTEGER milligrams and money INTEGER minor units, as elsewhere.

CREATE TABLE IF NOT EXISTS chits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chit_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  start_date TEXT NOT NULL,
  monthly_amount_minor INTEGER NOT NULL CHECK (monthly_amount_minor > 0),
  duration_months INTEGER NOT NULL CHECK (duration_months > 0),
  metal TEXT NOT NULL DEFAULT 'Gold',
  purity TEXT NOT NULL DEFAULT '22K',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REDEEMED', 'CANCELLED')),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chits_customer ON chits (customer_id);

-- One row per payment, never edited: the rate and weight used are frozen here.
CREATE TABLE IF NOT EXISTS chit_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chit_id INTEGER NOT NULL REFERENCES chits (id),
  payment_no INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  rate_per_gram_minor INTEGER NOT NULL CHECK (rate_per_gram_minor > 0),
  metal_rate_id INTEGER REFERENCES metal_rates (id),
  rate_source TEXT NOT NULL CHECK (rate_source IN ('RECORDED', 'MANUAL')),
  gold_weight_mg INTEGER NOT NULL CHECK (gold_weight_mg > 0),
  method TEXT NOT NULL DEFAULT 'CASH',
  reference TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (chit_id, payment_no)
);

CREATE TABLE IF NOT EXISTS chit_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chit_id INTEGER NOT NULL UNIQUE REFERENCES chits (id),
  redemption_date TEXT NOT NULL,
  rate_per_gram_minor INTEGER NOT NULL,
  accumulated_weight_mg INTEGER NOT NULL,
  total_paid_minor INTEGER NOT NULL,
  chit_value_minor INTEGER NOT NULL,
  jewellery_value_minor INTEGER NOT NULL,
  making_charge_minor INTEGER NOT NULL DEFAULT 0,
  wastage_minor INTEGER NOT NULL DEFAULT 0,
  stone_charge_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  chit_applied_minor INTEGER NOT NULL,
  unused_chit_minor INTEGER NOT NULL DEFAULT 0,
  final_payable_minor INTEGER NOT NULL CHECK (final_payable_minor >= 0),
  items_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS chit_cancellations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chit_id INTEGER NOT NULL UNIQUE REFERENCES chits (id),
  cancellation_date TEXT NOT NULL,
  total_paid_minor INTEGER NOT NULL,
  accumulated_weight_mg INTEGER NOT NULL,
  settlement_type TEXT NOT NULL CHECK (settlement_type IN ('GOLD', 'CASH')),
  settlement_amount_minor INTEGER,
  settlement_weight_mg INTEGER,
  rate_per_gram_minor INTEGER,
  processed_by INTEGER NOT NULL REFERENCES users (id),
  approved_by_name TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((settlement_type = 'CASH' AND settlement_amount_minor IS NOT NULL)
      OR (settlement_type = 'GOLD' AND settlement_weight_mg IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS chit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chit_id INTEGER NOT NULL REFERENCES chits (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'PAYMENT', 'REDEEMED', 'CANCELLED')),
  details_json TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_chit_events_chit ON chit_events (chit_id);
