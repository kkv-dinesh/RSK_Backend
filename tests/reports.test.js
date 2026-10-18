import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-reports-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { createCustomer, listCustomers } = await import('../src/modules/customers/customer.service.js');
const { createSale, getSale, cancelSale } = await import('../src/modules/sales/sale.service.js');
const { recordPayment, listPayments } = await import('../src/modules/payments/payment.service.js');
const { listItems, listMovements } = await import('../src/modules/stock/stock.service.js');
const { salesReport, purchasesReport, creditReport, pledgesReport } = await import('../src/modules/reports/reports.service.js');
const { createPledge } = await import('../src/modules/pledges/pledge.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const supplier = createSupplier({ name: 'Report Bullion' });
const customer = createCustomer({ name: 'Report Customer' });

function stock(gross = 10) {
  return createPurchase({
    supplierId: supplier.id, paymentMethod: 'UPI',
    items: [{ category: 'Chain', metal: 'Gold', purity: '22K', gross, stone: 0, ratePerGram: 6000 }],
    createdBy: ownerId,
  });
}

test('stock register and movements list reflect purchases with filters and totals', () => {
  const purchase = stock();
  const tag = purchase.items[0].tagId;
  const items = listItems({ q: tag });
  assert.equal(items.total, 1);
  assert.equal(items.data[0].status, 'IN_STOCK');
  const moves = listMovements({ type: 'PURCHASE_IN', q: tag });
  assert.equal(moves.total, 1);
  assert.equal(moves.data[0].movementType, 'PURCHASE_IN');
});

test('sales report totals match individual sales, split cancelled, and group payments by method', () => {
  const a = stock(); const b = stock();
  const saleA = createSale({ customerId: customer.id, items: [{ inventoryItemId: a.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });
  const saleB = createSale({ customerId: customer.id, items: [{ inventoryItemId: b.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });
  recordPayment({ customerId: customer.id, saleId: saleA.id, amount: 1000, method: 'UPI', createdBy: ownerId });
  cancelSale(saleB.id, { reason: 'test', userId: ownerId });

  const report = salesReport({});
  assert.ok(report.totals.cancelledCount >= 1);
  const row = report.sales.find((s) => s.id === saleA.id);
  assert.equal(row.total, getSale(saleA.id).total);
  assert.ok(report.byMethod.find((m) => m.method === 'UPI').amount >= 1000);
});

test('purchases report groups by supplier and payment method', () => {
  stock();
  const report = purchasesReport({});
  assert.ok(report.bySupplier.find((s) => s.name === 'Report Bullion'));
  assert.ok(report.byMethod.find((m) => m.method === 'UPI'));
});

test('credit report buckets outstanding by invoice age and reconciles with the customer ledger', () => {
  const p = stock();
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: p.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });
  const aged = creditReport({ now: Date.now() + 100 * 86400000 });
  const row = aged.customers.find((c) => c.customerId === customer.id);
  assert.ok(row.buckets.over90 > 0, 'a 100-day-old invoice lands in the 90+ bucket');
  assert.ok(row.outstanding >= sale.total);
  const listed = listCustomers({ limit: 200 }).find((c) => c.id === customer.id);
  assert.equal(listed.balance, creditReport().customers.find((c) => c.customerId === customer.id).outstanding);
});

test('payments list returns customer name and filters by method', () => {
  const upi = listPayments({ method: 'UPI' });
  assert.ok(upi.total >= 1);
  assert.equal(upi.data[0].customerName, 'Report Customer');
  assert.equal(listPayments({ method: 'CHEQUE' }).total, 0);
});

test('pledges report summarises active principal', () => {
  createPledge({ customerId: customer.id, items: [{ description: 'Ring' }], principal: 5000, startDate: '2026-01-01', createdBy: ownerId });
  const report = pledgesReport();
  assert.equal(report.totals.activeCount, 1);
  assert.equal(report.totals.activePrincipal, 5000);
});

test('sale and purchase previews match what is actually saved', async () => {
  const { previewSale } = await import('../src/modules/sales/sale.service.js');
  const { previewPurchase } = await import('../src/modules/purchases/purchase.service.js');
  const lines = [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 12.345, stone: 0.5, ratePerGram: 6100.5 }];
  const buyPreview = previewPurchase({ items: lines });
  const bought = createPurchase({ supplierId: supplier.id, items: lines, createdBy: ownerId });
  assert.equal(buyPreview.total, bought.totalAmount);

  const itemId = bought.items[0].inventoryItemId;
  const body = { items: [{ inventoryItemId: itemId, ratePerGram: 6500.25, wastageCharge: 120, stoneCharge: 75.5 }], discount: 100, tax: 40 };
  const preview = previewSale(body);
  assert.equal(getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(itemId).status, 'IN_STOCK', 'preview must not sell the item');
  const sale = createSale({ customerId: customer.id, ...body, createdBy: ownerId });
  assert.equal(preview.total, sale.total);
  assert.equal(preview.lines[0].lineTotal, sale.items[0].lineTotal);
  assert.equal(preview.lines[0].makingChargePercent, 10); // 11.845 g net is in the 9g-and-above tier
  assert.throws(() => previewSale({ items: [{ inventoryItemId: itemId, ratePerGram: 6000 }] }), /not available/);
});

test('audit search filters by action and returns the acting user name with a total', async () => {
  const { searchAudit, listAuditActions } = await import('../src/modules/audit/audit.service.js');
  const found = searchAudit({ action: 'PURCHASE_CREATE', limit: 5 });
  assert.ok(found.total >= 1);
  assert.equal(found.data[0].userName, 'Shop Owner (Demo)');
  assert.ok(listAuditActions().includes('PURCHASE_CREATE'));
  assert.equal(searchAudit({ action: 'NOPE' }).total, 0);
});
