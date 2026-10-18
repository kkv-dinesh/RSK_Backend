import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-purchase-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase, cancelPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { itemLedger, reconcileItem, adjustWeight, listAvailableItems } = await import('../src/modules/stock/stock.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const supplier = createSupplier({ name: 'Test Bullion Supplier' });

test('a completed purchase creates exactly one PURCHASE_IN movement per item', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    reference: 'PO-1',
    items: [
      { category: 'Ring', metal: 'Gold', purity: '22K', gross: 8.65, stone: 0.25, ratePerGram: 6500 },
      { category: 'Chain', metal: 'Gold', purity: '22K', gross: 18.62, stone: 0, ratePerGram: 6500 },
    ],
    createdBy: ownerId,
  });

  assert.equal(purchase.items.length, 2);
  for (const item of purchase.items) {
    const ledger = itemLedger(item.inventoryItemId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].movement_type, 'PURCHASE_IN');
  }
});

test('purchase total is the sum of item line totals, computed server-side', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Bangle', metal: 'Gold', purity: '22K', gross: 24.31, stone: 0, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  const expected = Math.round((6500 * 100 * 24310) / 1000) / 100; // minor-unit math, converted back
  assert.equal(purchase.totalAmount, expected);
});

test('a failed purchase (invalid weight) rolls back fully — no orphan item or movement', () => {
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM inventory_items').get().n;
  assert.throws(() =>
    createPurchase({
      supplierId: supplier.id,
      items: [
        { category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6500 },
        { category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 6, ratePerGram: 6500 }, // stone > gross
      ],
      createdBy: ownerId,
    })
  );
  const after = db.prepare('SELECT COUNT(*) AS n FROM inventory_items').get().n;
  assert.equal(before, after, 'no item should have been created when the batch fails');
});

test('cancelling a purchase reverses stock but preserves the original movement', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Earring', metal: 'Gold', purity: '22K', gross: 6.42, stone: 0, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  const itemId = purchase.items[0].inventoryItemId;

  const cancelled = cancelPurchase(purchase.id, { reason: 'Supplier recall', userId: ownerId });
  assert.equal(cancelled.status, 'CANCELLED');

  const ledger = itemLedger(itemId);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].movement_type, 'PURCHASE_IN');
  assert.equal(ledger[1].movement_type, 'REVERSAL');
  assert.equal(ledger[1].reversed_movement_id, ledger[0].id);

  const item = getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(itemId);
  assert.equal(item.status, 'REMOVED');
});

test('cancelling an already-cancelled purchase is rejected', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  cancelPurchase(purchase.id, { reason: 'first cancel', userId: ownerId });
  assert.throws(() => cancelPurchase(purchase.id, { reason: 'second cancel', userId: ownerId }), /already cancelled/);
});

test('a reversed movement cannot be reversed twice (DB uniqueness)', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  cancelPurchase(purchase.id, { reason: 'test', userId: ownerId });
  const itemId = purchase.items[0].inventoryItemId;
  const original = itemLedger(itemId)[0];

  const db = getDb();
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO stock_movements
           (inventory_item_id, movement_type, quantity_delta, weight_delta_mg, reason, reversed_movement_id, created_by)
         VALUES (?, 'REVERSAL', -1, 0, 'duplicate reversal attempt', ?, ?)`
      )
      .run(itemId, original.id, ownerId)
  );
});

test('reconcileItem matches ledger totals for an untouched in-stock item', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5.5, stone: 0.1, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  const result = reconcileItem(purchase.items[0].inventoryItemId);
  assert.ok(result.matchesWeight);
  assert.ok(result.matchesStock);
});

test('listAvailableItems only returns IN_STOCK items, with the id needed to reference them in a sale', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  const available = listAvailableItems();
  const found = available.find((i) => i.id === purchase.items[0].inventoryItemId);
  assert.ok(found);
  assert.equal(found.tagId, purchase.items[0].tagId);
});

test('a weight adjustment requires a reason and is reflected in the ledger', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5.5, stone: 0, ratePerGram: 6500 }],
    createdBy: ownerId,
  });
  const itemId = purchase.items[0].inventoryItemId;
  const db = getDb();
  assert.throws(() => db.transaction(() => adjustWeight(db, { inventoryItemId: itemId, newNetWeightMg: 5400, reason: '', createdBy: ownerId }))());

  db.transaction(() => adjustWeight(db, { inventoryItemId: itemId, newNetWeightMg: 5400, reason: 'Physical recount', createdBy: ownerId }))();
  const ledger = itemLedger(itemId);
  assert.equal(ledger.at(-1).movement_type, 'ADJUSTMENT');
  assert.equal(ledger.at(-1).weight_delta_mg, -100);
});
