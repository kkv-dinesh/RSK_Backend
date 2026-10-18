import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-catalog-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { getDb } = await import('../src/db/connection.js');
const { createProduct, listProducts } = await import('../src/modules/catalog/product.service.js');
const { recordRate, latestRate, listRateHistory } = await import('../src/modules/catalog/rate.service.js');

seed();
const ownerId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('owner').id;

test('product design uniqueness is enforced', () => {
  createProduct({ designNo: 'R-245', category: 'Ring', metal: 'Gold', purity: '22K' });
  assert.throws(() => createProduct({ designNo: 'R-245', category: 'Ring', metal: 'Gold', purity: '22K' }), /already exists/);
});

test('product list returns created designs', () => {
  const list = listProducts({ category: 'Ring' });
  assert.ok(list.some((p) => p.designNo === 'R-245'));
});

test('recording a new rate never overwrites the previous one', () => {
  recordRate({ metal: 'GOLD', purity: '22K', ratePerGram: 6500, effectiveDate: '2026-10-01', recordedBy: ownerId });
  recordRate({ metal: 'GOLD', purity: '22K', ratePerGram: 6600, effectiveDate: '2026-10-05', recordedBy: ownerId });

  const history = listRateHistory({ metal: 'GOLD', purity: '22K' });
  assert.equal(history.length, 2);
  assert.equal(latestRate('GOLD', '22K').ratePerGram, 6600);
});

test('rate must be a positive number', () => {
  assert.throws(() => recordRate({ metal: 'GOLD', purity: '22K', ratePerGram: 0, effectiveDate: '2026-10-01', recordedBy: ownerId }));
  assert.throws(() => recordRate({ metal: 'GOLD', purity: '22K', ratePerGram: -5, effectiveDate: '2026-10-01', recordedBy: ownerId }));
});

test('a rate change writes an audit log entry', () => {
  const rate = recordRate({ metal: 'SILVER', purity: '999', ratePerGram: 85, effectiveDate: '2026-10-10', recordedBy: ownerId });
  const audit = getDb().prepare('SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ?').get('metal_rate', String(rate.id));
  assert.ok(audit);
  assert.equal(audit.action, 'RATE_CHANGE');
});
