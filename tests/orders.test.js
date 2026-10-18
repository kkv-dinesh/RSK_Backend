import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-orders-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createCustomer } = await import('../src/modules/customers/customer.service.js');
const { createOrder, transitionOrder } = await import('../src/modules/orders/order.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
const customer = createCustomer({ name: 'Custom Order Customer' });

function newOrder() {
  return createOrder({ customerId: customer.id, items: [{ description: 'Custom 22K ring, size 18' }], createdBy: ownerId });
}

test('a new order starts in DRAFT', () => {
  const order = newOrder();
  assert.equal(order.status, 'DRAFT');
});

test('valid forward transitions succeed and are recorded in history', () => {
  const order = newOrder();
  transitionOrder(order.id, { toStatus: 'CONFIRMED', userId: ownerId });
  const after = transitionOrder(order.id, { toStatus: 'IN_PROGRESS', userId: ownerId });
  assert.equal(after.status, 'IN_PROGRESS');
  assert.equal(after.history.length, 2);
  assert.equal(after.history[0].toStatus, 'CONFIRMED');
});

test('an invalid transition is rejected on the backend', () => {
  const order = newOrder();
  assert.throws(() => transitionOrder(order.id, { toStatus: 'DELIVERED', userId: ownerId }), /Cannot transition order/);
});

test('DRAFT -> CANCELLED is a valid terminal transition, and nothing is allowed after', () => {
  const order = newOrder();
  const cancelled = transitionOrder(order.id, { toStatus: 'CANCELLED', reason: 'Customer backed out', userId: ownerId });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.throws(() => transitionOrder(order.id, { toStatus: 'CONFIRMED', userId: ownerId }));
});

test('ON_HOLD remembers where it came from and RESUME returns there', () => {
  const order = newOrder();
  transitionOrder(order.id, { toStatus: 'CONFIRMED', userId: ownerId });
  const held = transitionOrder(order.id, { toStatus: 'ON_HOLD', reason: 'Awaiting gemstone', userId: ownerId });
  assert.equal(held.status, 'ON_HOLD');
  assert.equal(held.heldFromStatus, 'CONFIRMED');

  const resumed = transitionOrder(order.id, { toStatus: 'RESUME', userId: ownerId });
  assert.equal(resumed.status, 'CONFIRMED');
  assert.equal(resumed.heldFromStatus, null);
});

test('every transition records who changed it and when', () => {
  const order = newOrder();
  const after = transitionOrder(order.id, { toStatus: 'CONFIRMED', reason: 'Advance received', userId: ownerId });
  const entry = after.history.at(-1);
  assert.equal(entry.changedBy, ownerId);
  assert.ok(entry.at);
  assert.equal(entry.reason, 'Advance received');
});

test('confirmed shop flow: a new order can go straight to work in progress, then ready, delivered, completed', () => {
  const order = newOrder();
  for (const toStatus of ['IN_PROGRESS', 'READY', 'DELIVERED', 'COMPLETED']) {
    assert.equal(transitionOrder(order.id, { toStatus, userId: ownerId }).status, toStatus);
  }
  assert.throws(() => transitionOrder(order.id, { toStatus: 'READY', userId: ownerId }), /Cannot transition/);
});

test('work cannot jump from a new order straight to ready or delivered', () => {
  const order = newOrder();
  assert.throws(() => transitionOrder(order.id, { toStatus: 'READY', userId: ownerId }), /Cannot transition/);
  assert.throws(() => transitionOrder(order.id, { toStatus: 'DELIVERED', userId: ownerId }), /Cannot transition/);
});
