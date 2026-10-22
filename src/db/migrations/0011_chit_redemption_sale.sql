-- A chit redeemed for jewellery now raises a real sale (stock leaves, invoice and ledger entries are created).
ALTER TABLE chit_redemptions ADD COLUMN sale_id INTEGER REFERENCES sales (id);
