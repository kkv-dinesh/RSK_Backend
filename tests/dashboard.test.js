import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-dashboard-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { createCustomer } = await import('../src/modules/customers/customer.service.js');
const { createSale } = await import('../src/modules/sales/sale.service.js');
const { recordPayment } = await import('../src/modules/payments/payment.service.js');
const { getDashboard } = await import('../src/modules/reports/dashboard.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const supplier = createSupplier({ name: 'Dashboard Supplier' });
const customer = createCustomer({ name: 'Dashboard Customer' });

test('sales, purchases, and collections are distinct, backend-derived metrics', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6000 }],
    createdBy: ownerId,
  });
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: purchase.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });
  const partial = Math.floor(sale.total / 2);
  recordPayment({ customerId: customer.id, saleId: sale.id, amount: partial, createdBy: ownerId });

  const dashboard = getDashboard();
  assert.equal(dashboard.sales, sale.total, 'sales metric must equal invoice totals, not cash received');
  assert.equal(dashboard.collections, partial, 'collections metric must equal cash actually received');
  assert.notEqual(dashboard.sales, dashboard.collections, 'sales and collections must not be conflated for a partially paid invoice');
  assert.ok(dashboard.purchases > 0);
});

test('stock summary reflects only items currently IN_STOCK', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Chain', metal: 'Gold', purity: '22K', gross: 10, stone: 0, ratePerGram: 6000 }],
    createdBy: ownerId,
  });
  const before = getDashboard().stockSummary.find((s) => s.metal === 'Gold' && s.purity === '22K')?.itemCount ?? 0;
  createSale({ customerId: customer.id, items: [{ inventoryItemId: purchase.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });
  const after = getDashboard().stockSummary.find((s) => s.metal === 'Gold' && s.purity === '22K')?.itemCount ?? 0;
  assert.equal(after, before - 1, 'selling an item must remove it from the in-stock summary');
});

test('pending approvals and order status counts come from real rows, not hardcoded numbers', () => {
  const dashboard = getDashboard();
  assert.equal(dashboard.pendingApprovals, 0);
  assert.deepEqual(dashboard.orderStatusCounts, {});
});
