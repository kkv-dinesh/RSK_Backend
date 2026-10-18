import { ValidationError } from '../../lib/errors.js';

// Confirmed business rules (gold pricing & making charges): the daily gold
// rate is the base rate for metal value; making charge is a percentage of
// metal value set by the item's net weight tier; wastage, stone charges, tax,
// and discount are manual, editable per-transaction entries (not formulas).
// Each step stays a separate, independently testable function per the
// business-logic-verification skill; do not duplicate this arithmetic
// anywhere else (frontend or backend).

export function calculateMetalValue(netWeightMg, ratePerGramMinor) {
  if (netWeightMg < 0) throw new ValidationError('netWeightMg cannot be negative.');
  if (ratePerGramMinor <= 0) throw new ValidationError('ratePerGramMinor must be positive.');
  return Math.round((ratePerGramMinor * netWeightMg) / 1000);
}

// Confirmed making-charge tiers: up to 8.99g net weight -> 20% of metal value;
// 9g and above -> 10% of metal value.
export const MAKING_CHARGE_WEIGHT_THRESHOLD_GRAMS = 9;
export const MAKING_CHARGE_RATE_LOW_TIER = 0.20;
export const MAKING_CHARGE_RATE_HIGH_TIER = 0.10;

export function makingChargeRateForWeight(netWeightMg) {
  if (netWeightMg < 0) throw new ValidationError('netWeightMg cannot be negative.');
  const netGrams = netWeightMg / 1000;
  return netGrams < MAKING_CHARGE_WEIGHT_THRESHOLD_GRAMS ? MAKING_CHARGE_RATE_LOW_TIER : MAKING_CHARGE_RATE_HIGH_TIER;
}

export function calculateMakingCharge(netWeightMg, metalValueMinor) {
  if (metalValueMinor < 0) throw new ValidationError('metalValueMinor cannot be negative.');
  const rate = makingChargeRateForWeight(netWeightMg);
  return Math.round(metalValueMinor * rate);
}

// Confirmed: wastage is entered manually per transaction, never derived.
export function calculateWastageCharge(wastageChargeMinor = 0) {
  if (wastageChargeMinor < 0) throw new ValidationError('wastageChargeMinor cannot be negative.');
  return Math.round(wastageChargeMinor);
}

// Confirmed: stone weight/charge is optional and, when present, entered manually.
export function calculateStoneCharge(stoneChargeMinor = 0) {
  if (stoneChargeMinor < 0) throw new ValidationError('stoneChargeMinor cannot be negative.');
  return Math.round(stoneChargeMinor);
}

// Confirmed: discount is entered manually per transaction.
export function calculateDiscount(subtotalMinor, discountMinor = 0) {
  if (discountMinor < 0) throw new ValidationError('discountMinor cannot be negative.');
  if (discountMinor > subtotalMinor) throw new ValidationError('discountMinor cannot exceed the subtotal.');
  return Math.round(discountMinor);
}

// Confirmed: tax is entered manually per transaction (no fixed policy given); defaults to zero.
export function calculateTax(taxMinor = 0) {
  if (taxMinor < 0) throw new ValidationError('taxMinor cannot be negative.');
  return Math.round(taxMinor);
}

export function calculateFinalAmount({ metalValueMinor, makingChargeMinor, wastageChargeMinor, stoneChargeMinor, discountMinor, taxMinor }) {
  const subtotal = metalValueMinor + makingChargeMinor + wastageChargeMinor + stoneChargeMinor;
  const afterDiscount = subtotal - discountMinor;
  return { subtotalMinor: subtotal, totalMinor: afterDiscount + taxMinor };
}

/** Prices one sale line end to end, returning every intermediate figure for traceability. */
export function priceSaleLine({ netWeightMg, ratePerGramMinor, wastageChargeMinor = 0, stoneChargeMinor = 0 }) {
  const metalValueMinor = calculateMetalValue(netWeightMg, ratePerGramMinor);
  const makingChargeMinor = calculateMakingCharge(netWeightMg, metalValueMinor);
  const wastage = calculateWastageCharge(wastageChargeMinor);
  const stoneCharge = calculateStoneCharge(stoneChargeMinor);
  const lineTotalMinor = metalValueMinor + makingChargeMinor + wastage + stoneCharge;
  return { metalValueMinor, makingChargeMinor, wastageChargeMinor: wastage, stoneChargeMinor: stoneCharge, lineTotalMinor };
}
