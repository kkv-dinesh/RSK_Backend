import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMetalValue, calculateMakingCharge, calculateWastageCharge, calculateStoneCharge,
  calculateDiscount, calculateTax, priceSaleLine,
} from '../src/modules/sales/pricing.service.js';

test('metal value is rate * weight in grams, rounded to the nearest minor unit', () => {
  // 8400 mg (8.4g) * 650000 minor (6500.00) / 1000 = 5,460,000 minor = 54,600.00
  assert.equal(calculateMetalValue(8400, 650000), 5460000);
});

test('metal value rejects non-positive rate', () => {
  assert.throws(() => calculateMetalValue(1000, 0));
  assert.throws(() => calculateMetalValue(1000, -1));
});

test('making charge is 20% of metal value for net weight under 9g', () => {
  assert.equal(calculateMakingCharge(8400, 100000), 20000); // 8.4g -> 20%
  assert.equal(calculateMakingCharge(8990, 100000), 20000); // 8.99g -> 20%
});

test('making charge is 10% of metal value for net weight 9g and above', () => {
  assert.equal(calculateMakingCharge(9000, 100000), 10000); // 9g -> 10%
  assert.equal(calculateMakingCharge(18620, 100000), 10000); // 18.62g -> 10%
});

test('wastage charge is a manual, non-negative flat amount', () => {
  assert.equal(calculateWastageCharge(2345), 2345);
  assert.equal(calculateWastageCharge(), 0);
  assert.throws(() => calculateWastageCharge(-1));
});

test('stone charge passes through a non-negative flat amount', () => {
  assert.equal(calculateStoneCharge(12345), 12345);
  assert.throws(() => calculateStoneCharge(-1));
});

test('discount cannot exceed the subtotal', () => {
  assert.equal(calculateDiscount(10000, 5000), 5000);
  assert.throws(() => calculateDiscount(10000, 10001));
  assert.throws(() => calculateDiscount(10000, -1));
});

test('tax is a manual, non-negative flat amount, defaulting to zero', () => {
  assert.equal(calculateTax(), 0);
  assert.equal(calculateTax(500), 500);
  assert.throws(() => calculateTax(-1));
});

test('priceSaleLine composes the full pipeline correctly for a sub-9g item', () => {
  const result = priceSaleLine({ netWeightMg: 8400, ratePerGramMinor: 650000, wastageChargeMinor: 10000, stoneChargeMinor: 500000 });
  assert.equal(result.metalValueMinor, 5460000);
  assert.equal(result.makingChargeMinor, Math.round(5460000 * 0.2));
  assert.equal(result.wastageChargeMinor, 10000);
  assert.equal(result.stoneChargeMinor, 500000);
  assert.equal(result.lineTotalMinor, result.metalValueMinor + result.makingChargeMinor + result.wastageChargeMinor + result.stoneChargeMinor);
});

test('priceSaleLine applies the 10% tier for a 9g-and-above item', () => {
  const result = priceSaleLine({ netWeightMg: 18620, ratePerGramMinor: 650000 });
  assert.equal(result.makingChargeMinor, Math.round(result.metalValueMinor * 0.1));
});
