-- Pledges and interest (Phase 7). A pledge is a distinct domain from ordinary
-- sales/customer credit (spec §4.9). Interest policy (simple/compound,
-- day-count, partial period, minimum, grace period, renewal) is NOT
-- confirmed — every pledge records which rule/version/inputs it used so a
-- DEMO ONLY calculation is never silently mistaken for approved policy.
-- TODO(OWNER_POLICY).

CREATE TABLE IF NOT EXISTS pledges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SETTLED', 'CANCELLED')),
  principal_minor INTEGER NOT NULL CHECK (principal_minor > 0),
  start_date TEXT NOT NULL,
  interest_rule_code TEXT NOT NULL,
  rate_percent_per_month REAL NOT NULL CHECK (rate_percent_per_month >= 0),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  settled_at TEXT,
  settled_by INTEGER REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS pledge_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pledge_id INTEGER NOT NULL REFERENCES pledges (id),
  description TEXT NOT NULL,
  metal TEXT,
  purity TEXT,
  gross_weight_mg INTEGER,
  net_weight_mg INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pledge_items_pledge ON pledge_items (pledge_id);

-- Append-only accrual snapshots: every entry records the exact rule/rate/period
-- used, so a later policy change never rewrites past accrual history.
CREATE TABLE IF NOT EXISTS pledge_interest_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pledge_id INTEGER NOT NULL REFERENCES pledges (id),
  as_of_date TEXT NOT NULL,
  period_days INTEGER NOT NULL,
  rule_code TEXT NOT NULL,
  rate_percent_per_month REAL NOT NULL,
  accrued_minor INTEGER NOT NULL CHECK (accrued_minor >= 0),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pledge_interest_pledge ON pledge_interest_entries (pledge_id);

CREATE TABLE IF NOT EXISTS pledge_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pledge_id INTEGER NOT NULL REFERENCES pledges (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  applied_to TEXT NOT NULL CHECK (applied_to IN ('INTEREST', 'PRINCIPAL')),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pledge_payments_pledge ON pledge_payments (pledge_id);

CREATE TABLE IF NOT EXISTS pledge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pledge_id INTEGER NOT NULL REFERENCES pledges (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'INTEREST_ACCRUED', 'PAYMENT', 'RENEWED', 'SETTLED', 'CANCELLED')),
  details_json TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pledge_events_pledge ON pledge_events (pledge_id);
