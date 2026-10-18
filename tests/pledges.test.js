import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-pledges-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createCustomer } = await import('../src/modules/customers/customer.service.js');
const {
  createPledge, previewInterest, accrueInterest, recordPledgePayment, settlePledge, getPledge,
} = await import('../src/modules/pledges/pledge.service.js');
const { calculateMonthlyPledgeInterest } = await import('../src/modules/pledges/interest.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const customer = createCustomer({ name: 'Pledge Customer' });

test('confirmed rule: pledged 1 Jan, settled 31 Jan -> no interest charged', () => {
  const calc = calculateMonthlyPledgeInterest({
    principalMinor: 10_000_00, ratePercentPerMonth: 2, startDate: '2026-01-01', asOfDate: '2026-01-31',
  });
  assert.equal(calc.completedMonths, 0);
  assert.equal(calc.accruedMinor, 0);
});

test('confirmed rule: pledged 1 Jan, settled 1 Feb -> exactly one month\'s interest', () => {
  const calc = calculateMonthlyPledgeInterest({
    principalMinor: 10_000_00, ratePercentPerMonth: 2, startDate: '2026-01-01', asOfDate: '2026-02-01',
  });
  assert.equal(calc.completedMonths, 1);
  assert.equal(calc.accruedMinor, Math.floor((10_000_00 * 2 * 1) / 100));
});

test('confirmed rate: Rs 2 interest per Rs 100 principal per month', () => {
  const calc = calculateMonthlyPledgeInterest({
    principalMinor: 100_00, ratePercentPerMonth: 2, startDate: '2026-01-01', asOfDate: '2026-03-01',
  });
  assert.equal(calc.completedMonths, 2);
  assert.equal(calc.accruedMinor, 2 * 2_00); // Rs 2 per Rs 100 per month, for 2 months
});

test('asOfDate before startDate is rejected', () => {
  assert.throws(() => calculateMonthlyPledgeInterest({ principalMinor: 1000, ratePercentPerMonth: 1, startDate: '2026-02-01', asOfDate: '2026-01-01' }));
});

test('creating a pledge records the exact rule/rate used, defaulting to the confirmed 2% monthly rate', () => {
  const pledge = createPledge({
    customerId: customer.id,
    items: [{ description: '22K gold chain, 18g' }],
    principal: 50000, startDate: '2026-01-01', createdBy: ownerId,
  });
  assert.equal(pledge.interestRuleCode, 'CONFIRMED_MONTHLY_V1');
  assert.equal(pledge.ratePercentPerMonth, 2);
  assert.equal(pledge.principalOutstanding, 50000);
});

test('previewInterest does not write an entry; accrueInterest does', () => {
  const pledge = createPledge({
    customerId: customer.id, items: [{ description: 'Gold bangle' }],
    principal: 20000, ratePercentPerMonth: 2, startDate: '2026-01-01', createdBy: ownerId,
  });
  previewInterest(pledge.id, '2026-03-01');
  let after = getPledge(pledge.id);
  assert.equal(after.totalAccruedInterest, 0, 'preview must not write anything');

  accrueInterest(pledge.id, { asOfDate: '2026-03-01', userId: ownerId });
  after = getPledge(pledge.id);
  assert.ok(after.totalAccruedInterest > 0);
  assert.ok(after.events.some((e) => e.type === 'INTEREST_ACCRUED'));
});

test('a pledge payment cannot exceed outstanding interest/principal', () => {
  const pledge = createPledge({
    customerId: customer.id, items: [{ description: 'Gold ring' }],
    principal: 10000, ratePercentPerMonth: 1, startDate: '2026-01-01', createdBy: ownerId,
  });
  assert.throws(() => recordPledgePayment(pledge.id, { amount: 10001, appliedTo: 'PRINCIPAL', userId: ownerId }), /exceeds outstanding/);
});

test('settlement is rejected while principal or interest remain outstanding, and succeeds once paid off', () => {
  const pledge = createPledge({
    customerId: customer.id, items: [{ description: 'Gold necklace' }],
    principal: 10000, ratePercentPerMonth: 0, startDate: '2026-01-01', createdBy: ownerId,
  });
  assert.throws(() => settlePledge(pledge.id, { reason: 'Customer paid off', userId: ownerId }), /still has principal/);

  recordPledgePayment(pledge.id, { amount: 10000, appliedTo: 'PRINCIPAL', userId: ownerId });
  const settled = settlePledge(pledge.id, { reason: 'Customer paid off', userId: ownerId });
  assert.equal(settled.status, 'SETTLED');
});

test('settlement requires a reason and is authorized/traceable', () => {
  const pledge = createPledge({
    customerId: customer.id, items: [{ description: 'Gold earrings' }],
    principal: 5000, ratePercentPerMonth: 0, startDate: '2026-01-01', createdBy: ownerId,
  });
  recordPledgePayment(pledge.id, { amount: 5000, appliedTo: 'PRINCIPAL', userId: ownerId });
  assert.throws(() => settlePledge(pledge.id, { reason: '', userId: ownerId }));

  const settled = settlePledge(pledge.id, { reason: 'Paid in full', userId: ownerId });
  const audit = getDb().prepare("SELECT * FROM audit_logs WHERE entity_type = 'pledge' AND action = 'PLEDGE_SETTLE' AND entity_id = ?").get(String(pledge.id));
  assert.ok(audit);
  assert.equal(settled.status, 'SETTLED');
});

test('an already-settled pledge cannot be settled again', () => {
  const pledge = createPledge({
    customerId: customer.id, items: [{ description: 'Gold pendant' }],
    principal: 1000, ratePercentPerMonth: 0, startDate: '2026-01-01', createdBy: ownerId,
  });
  recordPledgePayment(pledge.id, { amount: 1000, appliedTo: 'PRINCIPAL', userId: ownerId });
  settlePledge(pledge.id, { reason: 'Paid', userId: ownerId });
  assert.throws(() => settlePledge(pledge.id, { reason: 'Again', userId: ownerId }), /Only an active pledge/);
});

test('accruing twice does not double-count; a later accrual adds only the increase', () => {
  const { accrueInterest: accrue, previewInterest: preview } = { accrueInterest, previewInterest };
  const pledge = createPledge({ customerId: customer.id, items: [{ description: 'Ring' }], principal: 10000, startDate: '2026-01-01', createdBy: ownerId });
  accrue(pledge.id, { asOfDate: '2026-03-01', userId: ownerId }); // 2 months
  const first = getPledge(pledge.id).totalAccruedInterest;
  accrue(pledge.id, { asOfDate: '2026-03-01', userId: ownerId });
  assert.equal(getPledge(pledge.id).totalAccruedInterest, first, 'same date again changes nothing');
  accrue(pledge.id, { asOfDate: '2026-04-01', userId: ownerId }); // 3 months
  assert.equal(getPledge(pledge.id).totalAccruedInterest, 600);
  assert.equal(preview(pledge.id, '2026-04-01').accruedMinor, 60000);
});

test('settle-in-full clears interest and principal atomically and rejects a second settlement', async () => {
  const { settleInFull } = await import('../src/modules/pledges/pledge.service.js');
  const pledge = createPledge({ customerId: customer.id, items: [{ description: 'Bangle' }], principal: 10000, startDate: '2026-01-01', createdBy: ownerId });
  assert.throws(() => settleInFull(pledge.id, { asOfDate: '2026-02-01', reason: '', userId: ownerId }), /reason/);
  const settled = settleInFull(pledge.id, { asOfDate: '2026-02-01', reason: 'Customer redeemed', userId: ownerId });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.principalOutstanding, 0);
  assert.equal(settled.interestOutstanding, 0);
  assert.equal(settled.totalAccruedInterest, 200); // exactly one completed month at 2%
  assert.throws(() => settleInFull(pledge.id, { asOfDate: '2026-02-01', reason: 'again', userId: ownerId }), /Only an active pledge/);
});

test('pledge settled on day 31 of the first month owes no interest', async () => {
  const { settleInFull } = await import('../src/modules/pledges/pledge.service.js');
  const pledge = createPledge({ customerId: customer.id, items: [{ description: 'Chain' }], principal: 10000, startDate: '2026-01-01', createdBy: ownerId });
  const settled = settleInFull(pledge.id, { asOfDate: '2026-01-31', reason: 'Redeemed within the month', userId: ownerId });
  assert.equal(settled.totalAccruedInterest, 0);
});

test('a pledge reports what it would cost to clear it on a given date', () => {
  const pledge = createPledge({ customerId: customer.id, items: [{ description: 'Necklace' }], principal: 10000, startDate: '2026-01-01', createdBy: ownerId });
  const due = getPledge(pledge.id, { asOfDate: '2026-03-01' }).dueToday;
  assert.equal(due.completedMonths, 2);
  assert.equal(due.interestToDate, 400);
  assert.equal(due.settlementAmount, 10400);
  assert.equal(getPledge(pledge.id, { asOfDate: '2026-01-31' }).dueToday.settlementAmount, 10000);
});
