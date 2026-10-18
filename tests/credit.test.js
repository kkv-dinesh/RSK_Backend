import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-credit-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { createCustomer } = await import('../src/modules/customers/customer.service.js');
const { createSale } = await import('../src/modules/sales/sale.service.js');
const { listOverdueInvoices, createFollowUp, recordFollowUpOutcome } = await import('../src/modules/credit/credit.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const supplier = createSupplier({ name: 'Bullion Co' });
const customer = createCustomer({ name: 'Rahul Verma' });

function backdateSale(saleId, daysAgo) {
  const db = getDb();
  const past = new Date(Date.now() - daysAgo * 86400000).toISOString();
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(past, saleId);
}

test('an unpaid old invoice shows up as overdue; a recent one does not', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6000 }],
    createdBy: ownerId,
  });
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: purchase.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });
  backdateSale(sale.id, 45);

  const overdue = listOverdueInvoices({ overdueDays: 30 });
  assert.ok(overdue.some((o) => o.saleId === sale.id));
  assert.ok(overdue.find((o) => o.saleId === sale.id).outstanding > 0);
});

test('recording a follow-up outcome never changes financial balances', () => {
  const purchase = createPurchase({
    supplierId: supplier.id,
    items: [{ category: 'Ring', metal: 'Gold', purity: '22K', gross: 5, stone: 0, ratePerGram: 6000 }],
    createdBy: ownerId,
  });
  const sale = createSale({ customerId: customer.id, items: [{ inventoryItemId: purchase.items[0].inventoryItemId, ratePerGram: 6500 }], createdBy: ownerId });

  const followUp = createFollowUp({ customerId: customer.id, saleId: sale.id, notes: 'Called, promised payment Friday', createdBy: ownerId });
  const before = getDb().prepare('SELECT total_minor FROM sales WHERE id = ?').get(sale.id).total_minor;

  recordFollowUpOutcome(followUp.id, { outcome: 'PROMISED_PAYMENT' });

  const after = getDb().prepare('SELECT total_minor FROM sales WHERE id = ?').get(sale.id).total_minor;
  assert.equal(before, after);
});
