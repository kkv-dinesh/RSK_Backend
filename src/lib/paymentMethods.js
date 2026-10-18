import { ValidationError } from './errors.js';

// Confirmed business rule: customer and supplier payments both use the same
// four methods, defaulting to CASH.
export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'CHEQUE'];
export const DEFAULT_PAYMENT_METHOD = 'CASH';

export function normalizePaymentMethod(method) {
  const resolved = method ?? DEFAULT_PAYMENT_METHOD;
  if (!PAYMENT_METHODS.includes(resolved)) {
    throw new ValidationError(`method must be one of ${PAYMENT_METHODS.join(', ')}.`, { field: 'method' });
  }
  return resolved;
}
