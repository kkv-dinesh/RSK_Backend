-- A refund issued when a sale is cancelled is linked back to that sale so the
-- invoice, payment list and reports can show exactly what was returned and why.
ALTER TABLE payments ADD COLUMN refund_for_sale_id INTEGER REFERENCES sales (id);
