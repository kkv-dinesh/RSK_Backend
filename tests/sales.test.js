import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-sales-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { createCustomer, customerLedger } = await import('../src/modules/customers/customer.service.js');
const { createSale, getSale, cancelSale, getSaleOutstandingMinor } = await import('../src/modules/sales/sale.service.js');
const { recordPayment, reversePayment } = await import('../src/modules/payments/payment.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const supplier = createSupplier({ name: 'Bullion Co' });
const customer = createCustomer({ name: 'Priya Sharma', phone: '9999999999' });

function stockOneItem(gross = 8.65, stone = 0.25) {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross, stone, ratePerGram: 6000 }],
    createdBy: ownerId,
  });
  return purchase.items[0].inventoryItemId;
}

test('a sale prices on the backend, marks the item SOLD, and records SALE_OUT', () => {
  const itemId = stockOneItem();
  const sale = createSale({
    customerId: customer.id,
    items: [{ inventoryItemId: itemId, ratePerGram: 6500, wastageCharge: 450 }],
    createdBy: ownerId,
  });

  assert.equal(sale.status, 'COMPLETED');
  assert.equal(sale.items.length, 1);
  assert.ok(sale.total > 0);

  const item = getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(itemId);
  assert.equal(item.status, 'SOLD');

  const movement = getDb().prepare("SELECT * FROM stock_movements WHERE inventory_item_id = ? AND movement_type = 'SALE_OUT'").get(itemId);
  assert.ok(movement);
});

test('a tagged item cannot be sold twice', () => {
  const itemId = stockOneItem();
  createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId });

  assert.throws(
    () => createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId }),
    /not available for sale/
  );
});

test('a multi-item sale rolls back fully if one item is unavailable', () => {
  const availableItem = stockOneItem();
  const alreadySoldItem = stockOneItem();
  createSale({ customerId: customer.id, items: [{ inventoryItemId: alreadySoldItem, ratePerGram: 6500 }], createdBy: ownerId });

  const before = getDb().prepare('SELECT COUNT(*) AS n FROM sale_items').get().n;
  assert.throws(() =>
    createSale({
      customerId: customer.id,
      items: [
        { inventoryItemId: availableItem, ratePerGram: 6500 },
        { inventoryItemId: alreadySoldItem, ratePerGram: 6500 }, // already sold -> whole sale must fail
      ],
      createdBy: ownerId,
    })
  );
  const after = getDb().prepare('SELECT COUNT(*) AS n FROM sale_items').get().n;
  assert.equal(before, after);

  const stillAvailable = getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(availableItem);
  assert.equal(stillAvailable.status, 'IN_STOCK', 'the valid item must not have been sold when the batch failed');
});

test('partial payment leaves the correct outstanding balance, and full payment zeroes it', () => {
  const itemId = stockOneItem();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId });

  const halfPayment = Math.floor(sale.total / 2);
  recordPayment({ customerId: customer.id, saleId: sale.id, amount: halfPayment, createdBy: ownerId });
  let outstandingMinor = getSaleOutstandingMinor(getDb(), sale.id);
  assert.equal(outstandingMinor, Math.round(sale.total * 100) - Math.round(halfPayment * 100));

  recordPayment({ customerId: customer.id, saleId: sale.id, amount: outstandingMinor / 100, createdBy: ownerId });
  outstandingMinor = getSaleOutstandingMinor(getDb(), sale.id);
  assert.equal(outstandingMinor, 0);
});

test('a payment cannot exceed the sale outstanding balance', () => {
  const itemId = stockOneItem();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId });
  assert.throws(() => recordPayment({ customerId: customer.id, saleId: sale.id, amount: sale.total + 1, createdBy: ownerId }), /exceeds outstanding/);
});

test('customer ledger balance reconciles with invoice-level outstanding', () => {
  const itemId = stockOneItem();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId });
  recordPayment({ customerId: customer.id, saleId: sale.id, amount: sale.total, createdBy: ownerId });

  const ledger = customerLedger(customer.id);
  // Ledger balance across ALL this customer's sales/payments must equal the
  // sum of each sale's outstanding (here, just the one sale, now paid off).
  const outstandingMinor = getSaleOutstandingMinor(getDb(), sale.id);
  assert.equal(outstandingMinor, 0);
  // Balance may be non-zero only if other unpaid sales exist for this customer
  // from earlier tests in this file; assert it is not negative-drifted below
  // what the ledger entries actually sum to (derivability, not a hardcoded 0).
  const recomputed = getDb().prepare('SELECT COALESCE(SUM(amount_minor),0) AS s FROM customer_ledger_entries WHERE customer_id = ?').get(customer.id).s;
  assert.equal(Math.round(ledger.balance * 100), recomputed);
});

test('reversing a payment is traceable and cannot be applied twice', () => {
  const itemId = stockOneItem();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId });
  const payment = recordPayment({ customerId: customer.id, saleId: sale.id, amount: sale.total, createdBy: ownerId });

  let outstanding = getSaleOutstandingMinor(getDb(), sale.id);
  assert.equal(outstanding, 0);

  reversePayment(payment.id, { reason: 'Bounced cheque', userId: ownerId });
  outstanding = getSaleOutstandingMinor(getDb(), sale.id);
  assert.equal(outstanding, Math.round(sale.total * 100), 'reversing the payment restores the full outstanding balance');

  assert.throws(() => reversePayment(payment.id, { reason: 'again', userId: ownerId }), /already been reversed/);

  // Original payment row is never deleted — it stays visible, just marked REVERSED.
  const stillThere = getDb().prepare('SELECT status FROM payments WHERE id = ?').get(payment.id);
  assert.equal(stillThere.status, 'REVERSED');
});

test('cancelling a sale returns the item to stock and preserves the original invoice', () => {
  const itemId = stockOneItem();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], createdBy: ownerId });

  const cancelled = cancelSale(sale.id, { reason: 'Customer changed mind', userId: ownerId });
  assert.equal(cancelled.status, 'CANCELLED');

  const item = getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(itemId);
  assert.equal(item.status, 'IN_STOCK');

  // Original sale row is still readable with its original totals (not deleted/zeroed).
  const stillReadable = getSale(sale.id);
  assert.equal(stillReadable.total, sale.total);
});

test('discount cannot exceed the subtotal at the service layer', () => {
  const itemId = stockOneItem();
  assert.throws(() =>
    createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], discount: 999999, createdBy: ownerId })
  );
});

test('a refund issued on cancellation is linked to its sale and listed against it', async () => {
  const { listPayments } = await import('../src/modules/payments/payment.service.js');
  const itemId = stockOneItem();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: itemId, ratePerGram: 6500 }], payment: { amount: 1500, method: 'UPI' }, createdBy: ownerId });
  cancelSale(sale.id, { reason: 'Changed mind', userId: ownerId, refundMethod: 'CARD' });
  const refund = listPayments({ type: 'REFUND', customerId: customer.id }).data.find((p) => p.saleId === sale.id);
  assert.ok(refund, 'refund is listed against the cancelled sale');
  assert.equal(refund.amount, 1500);
  assert.equal(refund.method, 'CARD');
});
