import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { toMinorUnits, fromMinorUnits } from '../../lib/money.js';
import { calculateMonthlyPledgeInterest, CONFIRMED_MONTHLY_RULE, CONFIRMED_RATE_PERCENT_PER_MONTH } from './interest.service.js';
import { recordAudit } from '../audit/audit.service.js';

function logEvent(db, pledgeId, eventType, details, userId) {
  db.prepare('INSERT INTO pledge_events (pledge_id, event_type, details_json, created_by) VALUES (?, ?, ?, ?)')
    .run(pledgeId, eventType, details != null ? JSON.stringify(details) : null, userId);
}

export function createPledge({ customerId, items, principal, ratePercentPerMonth = CONFIRMED_RATE_PERCENT_PER_MONTH, startDate, createdBy }) {
  if (!customerId) throw new ValidationError('customerId is required.');
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('At least one pledge item is required.');
  if (!Number.isFinite(principal) || principal <= 0) throw new ValidationError('principal must be a positive number.');
  if (!Number.isFinite(ratePercentPerMonth) || ratePercentPerMonth < 0) throw new ValidationError('ratePercentPerMonth must be a non-negative number.');
  if (!startDate) throw new ValidationError('startDate is required.');

  const db = getDb();
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new NotFoundError(`Customer ${customerId} not found.`);

  const run = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO pledges (customer_id, principal_minor, start_date, interest_rule_code, rate_percent_per_month, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(customerId, toMinorUnits(principal), startDate, CONFIRMED_MONTHLY_RULE, ratePercentPerMonth, createdBy);
    const pledgeId = result.lastInsertRowid;

    for (const item of items) {
      if (!item.description) throw new ValidationError('Each pledge item requires a description.');
      db.prepare(
        `INSERT INTO pledge_items (pledge_id, description, metal, purity, gross_weight_mg, net_weight_mg)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        pledgeId, item.description, item.metal ?? null, item.purity ?? null,
        item.grossWeightGrams != null ? Math.round(item.grossWeightGrams * 1000) : null,
        item.netWeightGrams != null ? Math.round(item.netWeightGrams * 1000) : null
      );
    }

    logEvent(db, pledgeId, 'CREATED', { customerId, principal, ratePercentPerMonth }, createdBy);
    recordAudit(db, { userId: createdBy, action: 'PLEDGE_CREATE', entityType: 'pledge', entityId: pledgeId, newState: { customerId, principal } });
    return pledgeId;
  });

  return getPledge(run());
}

function outstandingMinor(db, pledgeId) {
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
  const accrued = db.prepare('SELECT COALESCE(SUM(accrued_minor), 0) AS s FROM pledge_interest_entries WHERE pledge_id = ?').get(pledgeId).s;
  const paidInterest = db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS s FROM pledge_payments WHERE pledge_id = ? AND applied_to = 'INTEREST'").get(pledgeId).s;
  const paidPrincipal = db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS s FROM pledge_payments WHERE pledge_id = ? AND applied_to = 'PRINCIPAL'").get(pledgeId).s;
  return {
    principalOutstanding: pledge.principal_minor - paidPrincipal,
    interestOutstanding: accrued - paidInterest,
    totalAccruedInterest: accrued,
  };
}

/** Pure preview — computes but does not write an interest entry. */
export function previewInterest(pledgeId, asOfDate) {
  const db = getDb();
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
  if (!pledge) throw new NotFoundError(`Pledge ${pledgeId} not found.`);
  return calculateMonthlyPledgeInterest({
    principalMinor: pledge.principal_minor, ratePercentPerMonth: pledge.rate_percent_per_month,
    startDate: pledge.start_date, asOfDate,
  });
}

/**
 * Records interest accrued up to `asOfDate`. Each entry stores only the
 * increase since the last entry (never the running total), so accruing twice
 * can't double-count. History stays append-only and records the rule/rate used.
 */
function accrueWithin(db, pledge, asOfDate, userId) {
  const calc = calculateMonthlyPledgeInterest({
    principalMinor: pledge.principal_minor, ratePercentPerMonth: pledge.rate_percent_per_month,
    startDate: pledge.start_date, asOfDate,
  });
  const already = db.prepare('SELECT COALESCE(SUM(accrued_minor), 0) AS s FROM pledge_interest_entries WHERE pledge_id = ?').get(pledge.id).s;
  const delta = Math.max(0, calc.accruedMinor - already);
  if (delta > 0) {
    db.prepare(
      `INSERT INTO pledge_interest_entries (pledge_id, as_of_date, period_days, rule_code, rate_percent_per_month, accrued_minor, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(pledge.id, asOfDate, calc.periodDays, calc.ruleCode, pledge.rate_percent_per_month, delta, userId);
    logEvent(db, pledge.id, 'INTEREST_ACCRUED', { ...calc, addedMinor: delta }, userId);
  }
  return { calc, addedMinor: delta };
}

export function accrueInterest(pledgeId, { asOfDate, userId }) {
  const db = getDb();
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
  if (!pledge) throw new NotFoundError(`Pledge ${pledgeId} not found.`);
  if (pledge.status !== 'ACTIVE') throw new ConflictError('Interest can only accrue on an active pledge.');
  db.transaction(() => accrueWithin(db, pledge, asOfDate, userId))();
  return getPledge(pledgeId);
}

/**
 * Settles in one atomic step: brings interest up to `asOfDate`, records the
 * interest and principal payments that clear the pledge, and marks it settled.
 * Either all of it happens or none of it does.
 */
export function settleInFull(pledgeId, { asOfDate, reason, userId }) {
  if (!reason) throw new ValidationError('A settlement reason is required.');
  if (!asOfDate) throw new ValidationError('asOfDate is required.');
  const db = getDb();
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
  if (!pledge) throw new NotFoundError(`Pledge ${pledgeId} not found.`);
  if (pledge.status !== 'ACTIVE') throw new ConflictError('Only an active pledge can be settled.');

  db.transaction(() => {
    accrueWithin(db, pledge, asOfDate, userId);
    const { principalOutstanding, interestOutstanding } = outstandingMinor(db, pledgeId);
    if (interestOutstanding > 0) {
      db.prepare('INSERT INTO pledge_payments (pledge_id, amount_minor, applied_to, created_by) VALUES (?, ?, ?, ?)').run(pledgeId, interestOutstanding, 'INTEREST', userId);
      logEvent(db, pledgeId, 'PAYMENT', { amount: interestOutstanding / 100, appliedTo: 'INTEREST', settlement: true }, userId);
    }
    if (principalOutstanding > 0) {
      db.prepare('INSERT INTO pledge_payments (pledge_id, amount_minor, applied_to, created_by) VALUES (?, ?, ?, ?)').run(pledgeId, principalOutstanding, 'PRINCIPAL', userId);
      logEvent(db, pledgeId, 'PAYMENT', { amount: principalOutstanding / 100, appliedTo: 'PRINCIPAL', settlement: true }, userId);
    }
    db.prepare(`UPDATE pledges SET status = 'SETTLED', settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), settled_by = ? WHERE id = ?`).run(userId, pledgeId);
    logEvent(db, pledgeId, 'SETTLED', { reason, asOfDate, interestPaid: interestOutstanding / 100, principalPaid: principalOutstanding / 100 }, userId);
    recordAudit(db, {
      userId, action: 'PLEDGE_SETTLE', entityType: 'pledge', entityId: pledgeId,
      previousState: { status: 'ACTIVE' }, newState: { status: 'SETTLED', interestPaidMinor: interestOutstanding, principalPaidMinor: principalOutstanding, asOfDate }, reason,
    });
  })();
  return getPledge(pledgeId);
}

export function recordPledgePayment(pledgeId, { amount, appliedTo, userId }) {
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('amount must be a positive number.');
  if (!['INTEREST', 'PRINCIPAL'].includes(appliedTo)) throw new ValidationError('appliedTo must be INTEREST or PRINCIPAL.');

  const db = getDb();
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
  if (!pledge) throw new NotFoundError(`Pledge ${pledgeId} not found.`);
  if (pledge.status !== 'ACTIVE') throw new ConflictError('Payments can only be recorded against an active pledge.');

  const amountMinor = toMinorUnits(amount);
  const before = outstandingMinor(db, pledgeId);
  const cap = appliedTo === 'INTEREST' ? before.interestOutstanding : before.principalOutstanding;
  if (amountMinor > cap) throw new ValidationError(`Payment of ${amount} exceeds outstanding ${appliedTo.toLowerCase()} of ${cap / 100}.`);

  const run = db.transaction(() => {
    db.prepare('INSERT INTO pledge_payments (pledge_id, amount_minor, applied_to, created_by) VALUES (?, ?, ?, ?)')
      .run(pledgeId, amountMinor, appliedTo, userId);
    logEvent(db, pledgeId, 'PAYMENT', { amount, appliedTo }, userId);
    recordAudit(db, { userId, action: 'PLEDGE_PAYMENT', entityType: 'pledge', entityId: pledgeId, newState: { amount, appliedTo } });
  });
  run();
  return getPledge(pledgeId);
}

/** Atomic, traceable, and gated by the pledge.settle permission at the route layer. */
export function settlePledge(pledgeId, { reason, userId }) {
  if (!reason) throw new ValidationError('A settlement reason is required.');
  const db = getDb();
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
  if (!pledge) throw new NotFoundError(`Pledge ${pledgeId} not found.`);
  if (pledge.status !== 'ACTIVE') throw new ConflictError('Only an active pledge can be settled.');

  const { principalOutstanding, interestOutstanding } = outstandingMinor(db, pledgeId);
  if (principalOutstanding > 0 || interestOutstanding > 0) {
    throw new ConflictError(
      `Pledge ${pledgeId} still has principal ${principalOutstanding / 100} and interest ${interestOutstanding / 100} outstanding.`
    );
  }

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE pledges SET status = 'SETTLED', settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), settled_by = ? WHERE id = ?`
    ).run(userId, pledgeId);
    logEvent(db, pledgeId, 'SETTLED', { reason }, userId);
    recordAudit(db, { userId, action: 'PLEDGE_SETTLE', entityType: 'pledge', entityId: pledgeId, newState: { status: 'SETTLED' }, reason });
  });
  run();
  return getPledge(pledgeId);
}

/** What it would cost to clear an ACTIVE pledge on `asOfDate`: principal still owed plus interest for completed months, less interest already paid. */
function dueFigures(pledge, outstanding, asOfDate) {
  if (pledge.status !== 'ACTIVE') return null;
  const date = asOfDate || new Date().toISOString().slice(0, 10);
  if (date < pledge.start_date.slice(0, 10)) return { asOfDate: date, completedMonths: 0, interestToDate: 0, settlementAmount: fromMinorUnits(outstanding.principalOutstanding + outstanding.interestOutstanding) };
  const calc = calculateMonthlyPledgeInterest({ principalMinor: pledge.principal_minor, ratePercentPerMonth: pledge.rate_percent_per_month, startDate: pledge.start_date, asOfDate: date });
  const interestToDate = Math.max(calc.accruedMinor, outstanding.totalAccruedInterest);
  const paidInterest = outstanding.totalAccruedInterest - outstanding.interestOutstanding;
  return {
    asOfDate: date, completedMonths: calc.completedMonths, interestToDate: fromMinorUnits(interestToDate),
    settlementAmount: fromMinorUnits(outstanding.principalOutstanding + interestToDate - paidInterest),
  };
}

export function getPledge(id, { asOfDate } = {}) {
  const db = getDb();
  const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(id);
  if (!pledge) throw new NotFoundError(`Pledge ${id} not found.`);
  const items = db.prepare('SELECT * FROM pledge_items WHERE pledge_id = ?').all(id);
  const events = db.prepare('SELECT * FROM pledge_events WHERE pledge_id = ? ORDER BY id').all(id);
  const outstanding = outstandingMinor(db, id);
  const customerName = db.prepare('SELECT name FROM customers WHERE id = ?').get(pledge.customer_id)?.name ?? null;
  return {
    id: pledge.id,
    customerId: pledge.customer_id,
    customerName,
    status: pledge.status,
    principal: fromMinorUnits(pledge.principal_minor),
    startDate: pledge.start_date,
    interestRuleCode: pledge.interest_rule_code,
    ratePercentPerMonth: pledge.rate_percent_per_month,
    principalOutstanding: fromMinorUnits(outstanding.principalOutstanding),
    interestOutstanding: fromMinorUnits(outstanding.interestOutstanding),
    totalAccruedInterest: fromMinorUnits(outstanding.totalAccruedInterest),
    dueToday: dueFigures(pledge, outstanding, asOfDate),
    settledAt: pledge.settled_at,
    items: items.map((i) => ({
      description: i.description, metal: i.metal, purity: i.purity,
      grossWeightGrams: i.gross_weight_mg != null ? i.gross_weight_mg / 1000 : null,
      netWeightGrams: i.net_weight_mg != null ? i.net_weight_mg / 1000 : null,
    })),
    events: events.map((e) => ({ type: e.event_type, details: e.details_json ? JSON.parse(e.details_json) : null, at: e.created_at, by: e.created_by })),
  };
}

export function listPledges({ customerId, status, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (customerId) { clauses.push('customer_id = ?'); params.push(customerId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = db.prepare(`SELECT id FROM pledges ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params);
  return rows.map((r) => getPledge(r.id));
}
