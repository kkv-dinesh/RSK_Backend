import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWeights, gramsToMilligrams, milligramsToGrams } from '../src/modules/catalog/units.js';

test('net weight exactly equal to gross minus stone is accepted', () => {
  const { grossMg, stoneMg, netMg } = validateWeights({ gross: 8.65, stone: 0.25 });
  assert.equal(grossMg, 8650);
  assert.equal(stoneMg, 250);
  assert.equal(netMg, 8400);
});

test('net weight greater than gross is rejected', () => {
  assert.throws(() => validateWeights({ gross: 5, stone: 0, net: 6 }), /cannot exceed gross/);
});

test('negative weights are rejected', () => {
  assert.throws(() => validateWeights({ gross: -1, stone: 0 }));
  assert.throws(() => validateWeights({ gross: 5, stone: -1 }));
});

test('zero weight is accepted (boundary)', () => {
  const { grossMg, netMg } = validateWeights({ gross: 0, stone: 0 });
  assert.equal(grossMg, 0);
  assert.equal(netMg, 0);
});

test('gram <-> milligram conversion has no floating-point drift across repeated additions', () => {
  let totalMg = 0;
  for (let i = 0; i < 1000; i++) totalMg += gramsToMilligrams(0.001);
  assert.equal(totalMg, 1000);
  assert.equal(milligramsToGrams(totalMg), 1);
});

test('stone weight greater than gross weight is rejected', () => {
  assert.throws(() => validateWeights({ gross: 2, stone: 3 }), /Stone\/non-metal weight cannot exceed gross/);
});
