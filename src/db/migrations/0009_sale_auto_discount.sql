-- Part of a sale's discount that was added automatically at billing time to
-- settle the bill when the amount received fell short of the final amount.
-- Already included in discount_minor; stored separately for transparency.
ALTER TABLE sales ADD COLUMN auto_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (auto_discount_minor >= 0);
