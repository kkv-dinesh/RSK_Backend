import { ValidationError } from './errors.js';

// Money is stored as INTEGER minor units (paise, assuming a 2-decimal currency)
// — never raw floats. TODO(OWNER_POLICY): confirm currency and precision for
// the actual deployment; INR/paise is a development default only.
export function toMinorUnits(amount) {
  if (!Number.isFinite(amount)) throw new ValidationError('Amount must be a finite number.');
  return Math.round(amount * 100);
}

export function fromMinorUnits(minor) {
  return minor / 100;
}

export function requireNonNegativeMinor(minor, label = 'amount') {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new ValidationError(`${label} must be a non-negative integer minor-unit value.`, { field: label });
  }
  return minor;
}
