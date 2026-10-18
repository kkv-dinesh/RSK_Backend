import { ValidationError } from '../../lib/errors.js';

// Confirmed pledge interest rule: simple interest, calculated on a monthly
// basis, anchored to the pledge's calendar anniversary day. A month only
// counts once fully completed — e.g. pledged 1 Jan, settled 31 Jan = 0
// months charged; settled 1 Feb = 1 month charged. Rate is confirmed at 2%
// of principal per completed month (₹2 per ₹100 per month).
export const CONFIRMED_MONTHLY_RULE = 'CONFIRMED_MONTHLY_V1';
export const CONFIRMED_RATE_PERCENT_PER_MONTH = 2;

export function calculateMonthlyPledgeInterest({ principalMinor, ratePercentPerMonth, startDate, asOfDate }) {
  if (principalMinor <= 0) throw new ValidationError('principalMinor must be positive.');
  if (ratePercentPerMonth < 0) throw new ValidationError('ratePercentPerMonth cannot be negative.');
  const start = new Date(startDate);
  const asOf = new Date(asOfDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(asOf.getTime())) throw new ValidationError('Invalid date.');
  const periodDays = Math.floor((asOf.getTime() - start.getTime()) / 86400000);
  if (periodDays < 0) throw new ValidationError('asOfDate cannot be before startDate.');

  let completedMonths = (asOf.getUTCFullYear() - start.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - start.getUTCMonth());
  if (asOf.getUTCDate() < start.getUTCDate()) completedMonths -= 1;
  completedMonths = Math.max(0, completedMonths);

  const accruedMinor = Math.floor((principalMinor * ratePercentPerMonth * completedMonths) / 100);
  return { periodDays, completedMonths, accruedMinor, ruleCode: CONFIRMED_MONTHLY_RULE };
}
