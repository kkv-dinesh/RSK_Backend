import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-chits-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createCustomer, customerLedger } = await import('../src/modules/customers/customer.service.js');
const { createSupplier } = await import('../src/modules/purchases/supplier.service.js');
const { createPurchase } = await import('../src/modules/purchases/purchase.service.js');
const { getSale } = await import('../src/modules/sales/sale.service.js');
const { recordRate } = await import('../src/modules/catalog/rate.service.js');
const {
  createChit, recordChitPayment, getChit, listChits, previewRedemption, redeemChit, cancelChit, previewCancellation,
} = await import('../src/modules/chits/chit.service.js');

seed();
const owner = getDb().prepare('SELECT id, display_name FROM users WHERE username = ?').get('owner');
const ownerId = owner.id;
const customer = createCustomer({ name: 'Chit Customer', phone: '+91 98765-43210' });
const rate = (ratePerGram, effectiveDate) => recordRate({ metal: 'Gold', purity: '22K', ratePerGram, effectiveDate, recordedBy: ownerId });
const mk = (extra = {}) => createChit({ customerId: customer.id, startDate: '2026-01-01', monthlyAmount: 7500, durationMonths: 12, createdBy: ownerId, ...extra });
const supplier = createSupplier({ name: 'Bullion Co' });
const stock = (gross = 10, stone = 0) => createPurchase({
  supplierId: supplier.id, items: [{ category: 'Chain', metal: 'Gold', purity: '22K', gross, stone, ratePerGram: 6000 }], createdBy: ownerId,
}).items[0].inventoryItemId;
const pay = (id, paymentDate, extra = {}) => recordChitPayment(id, { paymentDate, createdBy: ownerId, ...extra });

rate(7930, '2026-01-01');
rate(8000, '2026-02-01');
rate(8500, '2026-04-01');

test('registration auto-numbers, enforces unique chit numbers, and starts with nothing paid', () => {
  const a = mk();
  assert.match(a.chitNumber, /^CH-\d{4}$/);
  assert.equal(a.paymentsMade, 0);
  assert.equal(a.paymentsRemaining, 12);
  const b = mk({ chitNumber: 'SER-77' });
  assert.equal(b.chitNumber, 'SER-77');
  assert.throws(() => mk({ chitNumber: 'SER-77' }), /already in use/);
});

test('payment converts to gold at the rate on the payment date (7500 / 7930 = 0.946 g)', () => {
  const c = mk();
  const after = pay(c.id, '2026-01-05');
  assert.equal(after.payments[0].goldWeightGrams, 0.946);
  assert.equal(after.payments[0].ratePerGram, 7930);
  assert.equal(after.totalPaid, 7500);
  assert.equal(after.paymentsMade, 1);
  assert.equal(after.paymentsRemaining, 11);
});

test('a missed month is not made up: each payment keeps its own date, rate and weight', () => {
  const c = mk();
  pay(c.id, '2026-01-10'); // 7930
  pay(c.id, '2026-03-02'); // paid late, rate in force on 2 Mar (8000)
  const after = pay(c.id, '2026-04-03'); // 8500
  assert.deepEqual(after.payments.map((p) => p.ratePerGram), [7930, 8000, 8500]);
  assert.deepEqual(after.payments.map((p) => p.goldWeightGrams), [0.946, 0.938, 0.882]);
  assert.equal(after.accumulatedWeightGrams, 2.766);
  assert.equal(after.paymentsMade, 3);
});

test('the amount can differ every month and is converted at the rate on that day', () => {
  const c = mk();
  pay(c.id, '2026-01-10', { amount: 5000 });  // 5000 / 7930 = 0.631 g
  const after = pay(c.id, '2026-02-10', { amount: 12000 }); // 12000 / 8000 = 1.5 g
  assert.deepEqual(after.payments.map((p) => p.amount), [5000, 12000]);
  assert.deepEqual(after.payments.map((p) => p.goldWeightGrams), [0.631, 1.5]);
  assert.equal(after.totalPaid, 17000);
  assert.equal(after.accumulatedWeightGrams, 2.131);
  assert.throws(() => pay(c.id, '2026-03-10', { amount: 0 }), /positive/);
  assert.throws(() => pay(c.id, '2026-03-10', { amount: -5 }), /positive/);
});

test('payment validation: no future date, none before start, rate required', () => {
  const c = mk();
  assert.throws(() => pay(c.id, '2999-01-01'), /future/);
  assert.throws(() => pay(c.id, '2025-12-31'), /before the chit start/);
  const early = mk({ startDate: '2020-01-01' });
  assert.throws(() => pay(early.id, '2020-01-05'), /No Gold 22K rate/);
  assert.equal(pay(early.id, '2020-01-05', { ratePerGram: 5000 }).payments[0].rateSource, 'MANUAL');
});

test('no payments beyond the chit duration', () => {
  const c = mk({ durationMonths: 2 });
  pay(c.id, '2026-01-10'); pay(c.id, '2026-02-10');
  assert.throws(() => pay(c.id, '2026-03-10'), /already been made/);
  assert.equal(getChit(c.id).isComplete, true);
});

test('search by chit number or customer phone', () => {
  const c = mk({ chitNumber: 'FIND-ME-1' });
  assert.ok(listChits({ q: 'find-me' }).some((x) => x.id === c.id));
  assert.ok(listChits({ q: '9876543210' }).some((x) => x.id === c.id));
  assert.ok(listChits({ q: '98765 43210' }).some((x) => x.id === c.id));
  assert.equal(listChits({ q: '0000000' }).length, 0);
});

test('redemption is a stock sale: pieces leave stock, an invoice is raised, the chit is applied as a payment', () => {
  const c = mk();
  pay(c.id, '2026-01-10'); pay(c.id, '2026-02-10'); // 0.946 + 0.938 = 1.884 g
  const itemId = stock(10);                          // 10 g net
  const input = {
    redemptionDate: '2026-04-10', ratePerGram: 8500,
    items: [{ inventoryItemId: itemId, ratePerGram: 8500, makingCharge: 1000, wastageCharge: 500 }],
    tax: 300, discount: 200,
  };
  const preview = previewRedemption(c.id, input);
  assert.equal(preview.chitValue, 16014); // 1.884 g * 8500
  assert.equal(preview.jewelleryValue, 85000);
  assert.equal(preview.total, 85000 + 1000 + 500 - 200 + 300);
  assert.equal(preview.finalPayable, preview.total - 16014);
  assert.equal(getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(itemId).status, 'IN_STOCK'); // preview writes nothing

  const done = redeemChit(c.id, { ...input, payment: { amount: 1000, method: 'UPI' }, createdBy: ownerId });
  assert.equal(done.status, 'REDEEMED');
  assert.equal(done.redemption.finalPayable, preview.finalPayable);
  assert.equal(getDb().prepare('SELECT status FROM inventory_items WHERE id = ?').get(itemId).status, 'SOLD');
  const sale = getSale(done.redemption.saleId);
  assert.equal(sale.total, preview.total);
  assert.equal(sale.outstanding, preview.finalPayable - 1000);
  const ledger = customerLedger(customer.id);
  assert.ok(ledger.entries.some((e) => e.sourceTransaction === `SALE-${sale.id}` && e.entryType === 'INVOICE'));
  assert.equal(getDb().prepare("SELECT method FROM payments WHERE reference = ?").get(`Chit ${done.chitNumber}`).method, 'CHIT');
  assert.throws(() => pay(c.id, '2026-04-10'), /active chit/);
  assert.throws(() => redeemChit(c.id, { ...input, createdBy: ownerId }), /active chit/);
});

test('making charge follows the sale tier rule unless overridden; wastage, stone, tax and discount default to 0', () => {
  const c = mk();
  pay(c.id, '2026-01-10');
  const itemId = stock(10); // 10 g -> 10% tier
  const r = previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: itemId, ratePerGram: 8000 }] });
  assert.equal(r.items[0].makingCharge, 8000);
  assert.equal(r.wastage, 0); assert.equal(r.stoneCharge, 0); assert.equal(r.tax, 0); assert.equal(r.discount, 0);
  const none = previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: itemId, ratePerGram: 8000, makingCharge: 0 }] });
  assert.equal(none.makingCharge, 0);
});

test('redemption caps the chit credit at the bill and records the unused value', () => {
  const c = mk();
  pay(c.id, '2026-01-10'); pay(c.id, '2026-02-10');
  const itemId = stock(0.5);
  const r = previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: itemId, ratePerGram: 8000, makingCharge: 0 }] });
  assert.equal(r.finalPayable, 0);
  assert.equal(r.chitApplied, 4000);
  assert.ok(r.unusedChitValue > 0);
});

test('only in-stock pieces can be used, each once', () => {
  const c = mk();
  pay(c.id, '2026-01-10');
  const itemId = stock(5);
  assert.throws(() => previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: 999999, ratePerGram: 8000 }] }), /not found/);
  assert.throws(() => previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: itemId, ratePerGram: 8000 }, { inventoryItemId: itemId, ratePerGram: 8000 }] }), /twice/);
  assert.throws(() => previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [] }), /at least one piece/);
  const c2 = mk();
  pay(c2.id, '2026-01-10');
  redeemChit(c2.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: itemId, ratePerGram: 8000 }], createdBy: ownerId });
  assert.throws(() => previewRedemption(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: itemId, ratePerGram: 8000 }] }), /not available/);
});

test('redeeming a chit with no payments is refused', () => {
  const c = mk();
  assert.throws(() => redeemChit(c.id, { redemptionDate: '2026-02-10', items: [{ inventoryItemId: stock(5), ratePerGram: 8000 }], createdBy: ownerId }), /no payments/);
});

test('cancellation as cash records totals, approver and an audit entry', () => {
  const c = mk();
  pay(c.id, '2026-01-10'); pay(c.id, '2026-02-10');
  const p = previewCancellation(c.id, { cancellationDate: '2026-04-10' });
  assert.equal(p.accumulatedWeightGrams, 1.884);
  const done = cancelChit(c.id, { cancellationDate: '2026-04-10', settlementType: 'CASH', approvedBy: 'Manager Ravi', reason: 'Moving away', processedBy: ownerId });
  assert.equal(done.status, 'CANCELLED');
  assert.equal(done.cancellation.settlementType, 'CASH');
  assert.equal(done.cancellation.settlementAmount, p.cashValue);
  assert.equal(done.cancellation.totalPaid, 15000);
  assert.equal(done.cancellation.approvedBy, 'Manager Ravi');
  assert.equal(done.cancellation.processedByName, owner.display_name);
  assert.ok(getDb().prepare("SELECT 1 FROM audit_logs WHERE action = 'CHIT_CANCEL' AND entity_id = ?").get(String(c.id)));
  assert.throws(() => cancelChit(c.id, { settlementType: 'GOLD', processedBy: ownerId }), /active chit/);
});

test('cancellation as gold defaults to the full accumulated weight; type is required', () => {
  const c = mk();
  pay(c.id, '2026-01-10');
  assert.throws(() => cancelChit(c.id, { processedBy: ownerId }), /GOLD or CASH/);
  const done = cancelChit(c.id, { settlementType: 'GOLD', processedBy: ownerId });
  assert.equal(done.cancellation.settlementWeightGrams, 0.946);
  assert.equal(done.cancellation.approvedBy, owner.display_name);
});
