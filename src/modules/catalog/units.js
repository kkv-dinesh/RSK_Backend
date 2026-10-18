import { ValidationError } from '../../lib/errors.js';

// Weights are stored as INTEGER milligrams (never raw floats) so additions and
// comparisons are exact. The API boundary accepts/returns decimal grams and
// converts here. DEMO ONLY precision default: 3 decimal places (= 1 mg).
// TODO(OWNER_POLICY): confirm accepted weight precision/unit and rounding rule.
export const WEIGHT_PRECISION = 3;

export function gramsToMilligrams(grams) {
  if (!Number.isFinite(grams)) throw new ValidationError('Weight must be a finite number.');
  return Math.round(grams * 1000);
}

export function milligramsToGrams(mg) {
  return mg / 1000;
}

/**
 * Validates gross/stone/net weights (given in grams) and returns the
 * exact-integer milligram values to persist, applying the core invariant:
 * net weight cannot exceed gross weight.
 */
export function validateWeights({ gross, stone = 0, net }) {
  for (const [label, value] of [['gross', gross], ['stone', stone]]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ValidationError(`${label} weight must be a non-negative number.`, { field: label });
    }
  }
  const grossMg = gramsToMilligrams(gross);
  const stoneMg = gramsToMilligrams(stone);
  if (stoneMg > grossMg) throw new ValidationError('Stone/non-metal weight cannot exceed gross weight.', { field: 'stone' });

  const derivedNetMg = grossMg - stoneMg;
  const netMg = net != null ? gramsToMilligrams(net) : derivedNetMg;

  if (netMg < 0) throw new ValidationError('Net weight cannot be negative.', { field: 'net' });
  if (netMg > grossMg) throw new ValidationError('Net weight cannot exceed gross weight.', { field: 'net' });

  return { grossMg, stoneMg, netMg };
}

export function itemWeightsToGrams(row) {
  return {
    grossWeight: milligramsToGrams(row.gross_weight_mg),
    stoneWeight: milligramsToGrams(row.stone_weight_mg),
    netWeight: milligramsToGrams(row.net_weight_mg),
  };
}
