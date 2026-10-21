import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-profit-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { createCustomer } = await import('../src/modules/customers/customer.service.js');
const { createSale, cancelSale, previewSale } = await import('../src/modules/sales/sale.service.js');
const { getProfit } = await import('../src/modules/reports/profit.service.js');
const { getDashboard } = await import('../src/modules/reports/dashboard.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const supplier = createSupplier({ name: 'Profit Supplier' });
const customer = createCustomer({ name: 'Profit Customer' });
const buy = (gross, rate) => createPurchase({
  supplierId: supplier.id, items: [{ category: 'Chain', metal: 'Gold', purity: '22K', gross, stone: 0, ratePerGram: rate }], createdBy: ownerId,
});
const line = (batch, rate = 6500) => [{ inventoryItemId: batch.items[0].inventoryItemId, ratePerGram: rate }];

test('profit = sale amount (after discount) minus the cost of the exact purchase batch sold', () => {
  const batch = buy(10, 6000); // cost 60,000
  const sale = createSale({ customerId: customer.id, items: line(batch), discount: 1000, createdBy: ownerId });
  // metal 65,000 + making 10% 6,500 = 71,500; discount 1,000 -> revenue 70,500
  assert.equal(sale.total, 70500);
  const profit = getProfit();
  const row = profit.batches.find((b) => b.purchaseId === batch.id);
  assert.equal(row.cost, 60000);
  assert.equal(row.revenue, 70500);
  assert.equal(row.profit, 10500);
  assert.equal(row.status, 'SOLD_OUT');
  assert.equal(profit.profit, 10500);
});

test('purchases made days apart are matched to their own sales, and unsold stock earns nothing yet', () => {
  const first = buy(10, 6000);
  const second = buy(10, 6400); // later purchase at a higher rate
  createSale({ customerId: customer.id, items: line(second), createdBy: ownerId });
  const { batches } = getProfit();
  const a = batches.find((b) => b.purchaseId === first.id);
  const b = batches.find((x) => x.purchaseId === second.id);
  assert.equal(a.status, 'UNSOLD');
  assert.equal(a.profit, 0);
  assert.equal(a.gramsRemaining, 10);
  // second: cost 64,000; revenue 65,000 + 6,500 = 71,500
  assert.equal(b.profit, 7500);
});

test('cancelling a sale removes its profit and returns the batch to unsold', () => {
  const batch = buy(5, 6000);
  const sale = createSale({ customerId: customer.id, items: line(batch), createdBy: ownerId });
  const before = getProfit().profit;
  cancelSale(sale.id, { reason: 'test', userId: ownerId });
  const after = getProfit();
  assert.ok(after.profit < before);
  assert.equal(after.batches.find((b) => b.purchaseId === batch.id).status, 'UNSOLD');
});

test('dashboard only includes profit when asked (profit.view)', () => {
  assert.equal(getDashboard().profit, null);
  assert.equal(typeof getDashboard({ includeProfit: true }).profit.profit, 'number');
});

test('received amount below the bill is added to the discount to settle it in full', () => {
  const batch = buy(10, 6000); // subtotal 71,500
  const preview = previewSale({ items: line(batch), discount: 1000, payAmount: 69500, settleShortfall: true });
  assert.equal(preview.total, 69500);
  assert.equal(preview.autoDiscount, 1000);
  assert.equal(preview.discount, 2000);
  const sale = createSale({
    customerId: customer.id, items: line(batch), discount: 1000, settleShortfall: true, payment: { amount: 69500, method: 'CASH' }, createdBy: ownerId,
  });
  assert.equal(sale.discount, 2000);
  assert.equal(sale.autoDiscount, 1000);
  assert.equal(sale.total, 69500);
  assert.equal(sale.outstanding, 0);
});

test('without the settle option a shortfall stays as a balance owing', () => {
  const batch = buy(10, 6000);
  const sale = createSale({ customerId: customer.id, items: line(batch), discount: 1000, payment: { amount: 69500, method: 'CASH' }, createdBy: ownerId });
  assert.equal(sale.discount, 1000);
  assert.equal(sale.autoDiscount, 0);
  assert.equal(sale.outstanding, 1000);
});

test('settling needs a received amount and cannot take the discount past the subtotal', () => {
  const batch = buy(10, 6000);
  assert.throws(() => createSale({ customerId: customer.id, items: line(batch), settleShortfall: true, createdBy: ownerId }), /amount received/);
  assert.throws(
    () => createSale({ customerId: customer.id, items: line(batch), settleShortfall: true, tax: 1000, payment: { amount: 500 }, createdBy: ownerId }),
    /too low/
  );
});
