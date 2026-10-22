import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { toMinorUnits, fromMinorUnits } from '../../lib/money.js';
import { normalizePaymentMethod } from '../../lib/paymentMethods.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordMovement } from '../stock/stock.service.js';
import { appendLedgerEntry } from '../customers/customer.service.js';
import { recordPaymentWithinTransaction } from '../sales/sale.service.js';
import {
  calculateMetalValue, calculateMakingCharge, calculateWastageCharge, calculateStoneCharge, calculateDiscount, calculateTax, makingChargeRateForWeight,
} from '../sales/pricing.service.js';

const DEFAULT_METAL = 'Gold';
const DEFAULT_PURITY = '22K';
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const todayStr = () => new Date().toISOString().slice(0, 10);
const mgToGrams = (mg) => mg / 1000;
const gramsToMg = (g) => Math.round(g * 1000);

function logEvent(db, chitId, eventType, details, userId) {
  db.prepare('INSERT INTO chit_events (chit_id, event_type, details_json, created_by) VALUES (?, ?, ?, ?)')
    .run(chitId, eventType, details != null ? JSON.stringify(details) : null, userId);
}

function loadChit(db, id) {
  const chit = db.prepare('SELECT * FROM chits WHERE id = ?').get(id);
  if (!chit) throw new NotFoundError(`Chit ${id} not found.`);
  return chit;
}

/**
 * The gold rate applicable on `date`: the latest recorded rate effective on or
 * before that date. A `manualRate` (a per-gram figure) overrides the lookup and
 * is flagged MANUAL in the payment history.
 */
export function rateOnDate(db, { metal, purity, date, manualRate }) {
  if (manualRate != null) {
    if (!Number.isFinite(manualRate) || manualRate <= 0) throw new ValidationError('ratePerGram must be a positive number.', { field: 'ratePerGram' });
    return { rateMinor: toMinorUnits(manualRate), rateId: null, source: 'MANUAL' };
  }
  const row = db.prepare(
    `SELECT id, rate_per_gram_minor FROM metal_rates WHERE metal = ? AND purity = ? AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC LIMIT 1`
  ).get(metal, purity, date);
  if (!row) throw new ValidationError(`No ${metal} ${purity} rate has been recorded on or before ${date}. Record the rate first.`, { field: 'date' });
  return { rateMinor: row.rate_per_gram_minor, rateId: row.id, source: 'RECORDED' };
}

/** Installments due by `asOf`: the first is due on the start date, then one per completed month. */
function installmentsDue(startDate, asOf, duration) {
  const s = new Date(`${startDate}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  if (a < s) return 0;
  let months = (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth());
  if (a.getUTCDate() < s.getUTCDate()) months -= 1;
  return Math.min(duration, months + 1);
}

function nextChitNumber(db) {
  let n = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM chits').get().n;
  const fmt = (i) => `CH-${String(i).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM chits WHERE chit_number = ?').get(fmt(n))) n += 1;
  return fmt(n);
}

export function createChit({ customerId, chitNumber, startDate, monthlyAmount, durationMonths, metal = DEFAULT_METAL, purity = DEFAULT_PURITY, createdBy }) {
  if (!customerId) throw new ValidationError('customerId is required.');
  if (!isDate(startDate)) throw new ValidationError('startDate must be a valid YYYY-MM-DD date.', { field: 'startDate' });
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) throw new ValidationError('monthlyAmount must be a positive number.', { field: 'monthlyAmount' });
  if (!Number.isInteger(durationMonths) || durationMonths <= 0 || durationMonths > 120) throw new ValidationError('durationMonths must be a whole number between 1 and 120.', { field: 'durationMonths' });

  const db = getDb();
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new NotFoundError(`Customer ${customerId} not found.`);

  const run = db.transaction(() => {
    const number = chitNumber != null && String(chitNumber).trim() !== '' ? String(chitNumber).trim() : nextChitNumber(db);
    if (db.prepare('SELECT 1 FROM chits WHERE chit_number = ?').get(number)) throw new ConflictError(`Chit number ${number} is already in use.`);
    const id = db.prepare(
      `INSERT INTO chits (chit_number, customer_id, start_date, monthly_amount_minor, duration_months, metal, purity, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(number, customerId, startDate, toMinorUnits(monthlyAmount), durationMonths, metal, purity, createdBy).lastInsertRowid;
    const state = { chitNumber: number, customerId, startDate, monthlyAmount, durationMonths, metal, purity };
    logEvent(db, id, 'CREATED', state, createdBy);
    recordAudit(db, { userId: createdBy, action: 'CHIT_CREATE', entityType: 'chit', entityId: id, newState: state });
    return id;
  });
  return getChit(run());
}

/**
 * Records one monthly payment as its own transaction. The gold it buys is
 * amount / rate on the payment date, rounded to the nearest milligram, and the
 * rate used is stored with the payment so later rate changes never alter it.
 */
export function recordChitPayment(chitId, { paymentDate, amount, ratePerGram, method, reference, createdBy }) {
  const db = getDb();
  const date = paymentDate ?? todayStr();
  if (!isDate(date)) throw new ValidationError('paymentDate must be a valid YYYY-MM-DD date.', { field: 'paymentDate' });
  if (date > todayStr()) throw new ValidationError('paymentDate cannot be in the future.', { field: 'paymentDate' });
  const payMethod = normalizePaymentMethod(method);

  const run = db.transaction(() => {
    const chit = loadChit(db, chitId);
    if (chit.status !== 'ACTIVE') throw new ConflictError(`Payments can only be recorded on an active chit (this one is ${chit.status.toLowerCase()}).`);
    if (date < chit.start_date) throw new ValidationError('paymentDate cannot be before the chit start date.', { field: 'paymentDate' });
    // The customer pays whatever they can each month; the chit's monthly amount is only the usual/suggested figure.
    if (amount != null && (!Number.isFinite(amount) || amount <= 0)) throw new ValidationError('amount must be a positive number.', { field: 'amount' });
    const amountMinor = amount == null ? chit.monthly_amount_minor : toMinorUnits(amount);
    if (amountMinor <= 0) throw new ValidationError('amount must be a positive number.', { field: 'amount' });
    const made = db.prepare('SELECT COUNT(*) AS n FROM chit_payments WHERE chit_id = ?').get(chitId).n;
    if (made >= chit.duration_months) throw new ConflictError('All payments for this chit have already been made.');
    const rate = rateOnDate(db, { metal: chit.metal, purity: chit.purity, date, manualRate: ratePerGram });
    const weightMg = Math.round((amountMinor / rate.rateMinor) * 1000);
    if (weightMg <= 0) throw new ValidationError('This payment is too small to buy any gold at that rate.');
    const paymentNo = made + 1;
    const id = db.prepare(
      `INSERT INTO chit_payments (chit_id, payment_no, payment_date, amount_minor, rate_per_gram_minor, metal_rate_id, rate_source, gold_weight_mg, method, reference, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(chitId, paymentNo, date, amountMinor, rate.rateMinor, rate.rateId, rate.source, weightMg, payMethod, reference ?? null, createdBy).lastInsertRowid;
    const detail = { paymentNo, paymentDate: date, amount: fromMinorUnits(amountMinor), ratePerGram: fromMinorUnits(rate.rateMinor), rateSource: rate.source, goldWeightGrams: mgToGrams(weightMg) };
    logEvent(db, chitId, 'PAYMENT', detail, createdBy);
    recordAudit(db, { userId: createdBy, action: 'CHIT_PAYMENT', entityType: 'chit', entityId: chitId, newState: detail, sourceTransaction: `CHITPAY-${id}` });
  });
  run();
  return getChit(chitId);
}

function totals(db, chitId) {
  const t = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS paid, COALESCE(SUM(gold_weight_mg), 0) AS mg FROM chit_payments WHERE chit_id = ?').get(chitId);
  return { made: t.n, paidMinor: t.paid, weightMg: t.mg };
}

/** The accumulated gold valued at the rate applicable on `date`. */
function chitCredit(db, chit, { date, ratePerGram }) {
  const t = totals(db, chit.id);
  const rate = rateOnDate(db, { metal: chit.metal, purity: chit.purity, date, manualRate: ratePerGram });
  return { ...t, rate, valueMinor: Math.round((t.weightMg / 1000) * rate.rateMinor) };
}

/** What the accumulated chit is worth on `date` (no writes). */
export function chitValuation(chitId, { date = todayStr(), ratePerGram } = {}) {
  const db = getDb();
  const chit = loadChit(db, chitId);
  const c = chitCredit(db, chit, { date, ratePerGram });
  return {
    date, ratePerGram: fromMinorUnits(c.rate.rateMinor), rateSource: c.rate.source,
    accumulatedWeightGrams: mgToGrams(c.weightMg), totalPaid: fromMinorUnits(c.paidMinor), chitValue: fromMinorUnits(c.valueMinor),
  };
}

const minorOrZero = (v, field) => {
  if (v == null || v === '') return 0;
  if (!Number.isFinite(v) || v < 0) throw new ValidationError(`${field} must be zero or a positive number.`, { field });
  return toMinorUnits(v);
};

/**
 * Prices the jewellery exactly like a sale: each piece must be tagged stock that
 * is still IN_STOCK, valued at net weight x rate. Making charge defaults to the
 * sale tier rule but can be overridden (0 when it doesn't apply); wastage and
 * stone charge are manual and default to 0, as do tax and discount.
 */
function priceRedemption(db, chit, { redemptionDate, ratePerGram, items, tax, discount }) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Select at least one piece from stock.', { field: 'items' });
  const seen = new Set();
  let subtotalMinor = 0;
  const lines = items.map((line) => {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(line.inventoryItemId);
    if (!item) throw new NotFoundError(`Inventory item ${line.inventoryItemId} not found.`);
    if (seen.has(item.id)) throw new ConflictError(`Item ${item.tag_id} is added twice.`);
    seen.add(item.id);
    if (item.status !== 'IN_STOCK') throw new ConflictError(`Item ${item.tag_id} is not available (status: ${item.status}).`);
    if (!Number.isFinite(line.ratePerGram) || line.ratePerGram <= 0) throw new ValidationError(`Enter the rate per gram for ${item.tag_id}.`, { field: 'items' });
    const rateMinor = toMinorUnits(line.ratePerGram);
    const metalValueMinor = calculateMetalValue(item.net_weight_mg, rateMinor);
    const suggestedMakingMinor = calculateMakingCharge(item.net_weight_mg, metalValueMinor);
    const makingMinor = line.makingCharge == null || line.makingCharge === '' ? suggestedMakingMinor : minorOrZero(line.makingCharge, 'makingCharge');
    const wastageMinor = calculateWastageCharge(minorOrZero(line.wastageCharge, 'wastage'));
    const stoneMinor = calculateStoneCharge(minorOrZero(line.stoneCharge, 'stoneCharge'));
    const lineTotalMinor = metalValueMinor + makingMinor + wastageMinor + stoneMinor;
    subtotalMinor += lineTotalMinor;
    return { item, rateMinor, metalValueMinor, makingMinor, suggestedMakingMinor, wastageMinor, stoneMinor, lineTotalMinor };
  });
  const discountMinor = calculateDiscount(subtotalMinor, minorOrZero(discount, 'discount'));
  const taxMinor = calculateTax(minorOrZero(tax, 'tax'));
  const totalMinor = subtotalMinor - discountMinor + taxMinor;
  const credit = chitCredit(db, chit, { date: redemptionDate, ratePerGram });
  const applied = Math.min(credit.valueMinor, totalMinor);
  return {
    lines, subtotalMinor, discountMinor, taxMinor, totalMinor,
    credit, appliedMinor: applied, unusedMinor: credit.valueMinor - applied, finalPayableMinor: totalMinor - applied,
  };
}

const sumOf = (lines, key) => lines.reduce((t, l) => t + l[key], 0);

function redemptionToApi(p, redemptionDate) {
  const m = fromMinorUnits;
  return {
    redemptionDate, ratePerGram: m(p.credit.rate.rateMinor), rateSource: p.credit.rate.source,
    accumulatedWeightGrams: mgToGrams(p.credit.weightMg), totalPaid: m(p.credit.paidMinor), chitValue: m(p.credit.valueMinor),
    items: p.lines.map((l) => ({
      inventoryItemId: l.item.id, tagId: l.item.tag_id, description: `${l.item.category} ${l.item.metal} ${l.item.purity}`,
      netWeightGrams: l.item.net_weight_mg / 1000, ratePerGram: m(l.rateMinor), metalValue: m(l.metalValueMinor),
      makingCharge: m(l.makingMinor), suggestedMakingCharge: m(l.suggestedMakingMinor), makingChargePercent: Math.round(makingChargeRateForWeight(l.item.net_weight_mg) * 100),
      wastage: m(l.wastageMinor), stoneCharge: m(l.stoneMinor), value: m(l.lineTotalMinor),
    })),
    jewelleryValue: m(sumOf(p.lines, 'metalValueMinor')), makingCharge: m(sumOf(p.lines, 'makingMinor')),
    wastage: m(sumOf(p.lines, 'wastageMinor')), stoneCharge: m(sumOf(p.lines, 'stoneMinor')),
    subtotal: m(p.subtotalMinor), tax: m(p.taxMinor), discount: m(p.discountMinor), total: m(p.totalMinor),
    chitApplied: m(p.appliedMinor), unusedChitValue: m(p.unusedMinor), finalPayable: m(p.finalPayableMinor),
  };
}

export function previewRedemption(chitId, input = {}) {
  const db = getDb();
  const chit = loadChit(db, chitId);
  const date = input.redemptionDate ?? todayStr();
  if (!isDate(date)) throw new ValidationError('redemptionDate must be a valid YYYY-MM-DD date.', { field: 'redemptionDate' });
  return redemptionToApi(priceRedemption(db, chit, { ...input, redemptionDate: date }), date);
}

/**
 * Redeems the chit for jewellery from stock, exactly like a sale: the pieces
 * leave stock, an invoice is raised for the customer, and the chit's value is
 * received against it as a CHIT payment. Any balance can be paid now. The chit
 * closes as REDEEMED. All of it happens in one transaction.
 */
export function redeemChit(chitId, { createdBy, payment, ...input }) {
  const db = getDb();
  const date = input.redemptionDate ?? todayStr();
  if (!isDate(date)) throw new ValidationError('redemptionDate must be a valid YYYY-MM-DD date.', { field: 'redemptionDate' });
  if (date > todayStr()) throw new ValidationError('redemptionDate cannot be in the future.', { field: 'redemptionDate' });

  const run = db.transaction(() => {
    const chit = loadChit(db, chitId);
    if (chit.status !== 'ACTIVE') throw new ConflictError(`Only an active chit can be redeemed (this one is ${chit.status.toLowerCase()}).`);
    const p = priceRedemption(db, chit, { ...input, redemptionDate: date });
    if (p.credit.weightMg <= 0) throw new ConflictError('This chit has no payments to redeem yet.');
    const api = redemptionToApi(p, date);
    const customerId = chit.customer_id;

    const saleId = db.prepare(
      `INSERT INTO sales (customer_id, status, subtotal_minor, discount_minor, tax_minor, total_minor, created_by)
       VALUES (?, 'COMPLETED', ?, ?, ?, ?, ?)`
    ).run(customerId, p.subtotalMinor, p.discountMinor, p.taxMinor, p.totalMinor, createdBy).lastInsertRowid;
    for (const l of p.lines) {
      db.prepare(
        `INSERT INTO sale_items (sale_id, inventory_item_id, rate_per_gram_minor, net_weight_mg, metal_value_minor, making_charge_minor, wastage_charge_minor, stone_charge_minor, line_total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(saleId, l.item.id, l.rateMinor, l.item.net_weight_mg, l.metalValueMinor, l.makingMinor, l.wastageMinor, l.stoneMinor, l.lineTotalMinor);
      db.prepare(`UPDATE inventory_items SET status = 'SOLD', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(l.item.id);
      recordMovement(db, {
        inventoryItemId: l.item.id, movementType: 'SALE_OUT', quantityDelta: -1, weightDeltaMg: -l.item.net_weight_mg,
        fromLocationId: l.item.location_id, reason: `Chit ${chit.chit_number} redemption`, sourceTransaction: `SALE-${saleId}`, createdBy,
      });
    }
    appendLedgerEntry(db, { customerId, entryType: 'INVOICE', amountMinor: p.totalMinor, sourceTransaction: `SALE-${saleId}`, createdBy });
    recordAudit(db, {
      userId: createdBy, action: 'SALE_CREATE', entityType: 'sale', entityId: saleId,
      newState: { customerId, totalMinor: p.totalMinor, discountMinor: p.discountMinor, itemCount: p.lines.length, chit: chit.chit_number }, sourceTransaction: `SALE-${saleId}`,
    });

    if (p.appliedMinor > 0) {
      const paymentId = db.prepare(
        `INSERT INTO payments (customer_id, amount_minor, method, reference, payment_type, created_by) VALUES (?, ?, 'CHIT', ?, ?, ?)`
      ).run(customerId, p.appliedMinor, `Chit ${chit.chit_number}`, p.appliedMinor === p.totalMinor ? 'FULL' : 'PARTIAL', createdBy).lastInsertRowid;
      db.prepare('INSERT INTO payment_allocations (payment_id, sale_id, amount_minor) VALUES (?, ?, ?)').run(paymentId, saleId, p.appliedMinor);
      appendLedgerEntry(db, { customerId, entryType: 'PAYMENT', amountMinor: -p.appliedMinor, sourceTransaction: `PAYMENT-${paymentId}-SALE-${saleId}`, createdBy });
      recordAudit(db, { userId: createdBy, action: 'PAYMENT_CREATE', entityType: 'payment', entityId: paymentId, newState: { customerId, saleId, amountMinor: p.appliedMinor, method: 'CHIT' } });
    }
    if (payment?.amount > 0) {
      recordPaymentWithinTransaction(db, {
        customerId, saleId, amountMinor: toMinorUnits(payment.amount), method: payment.method, reference: payment.reference ?? null, createdBy,
      });
    }

    db.prepare(
      `INSERT INTO chit_redemptions (chit_id, sale_id, redemption_date, rate_per_gram_minor, accumulated_weight_mg, total_paid_minor, chit_value_minor,
         jewellery_value_minor, making_charge_minor, wastage_minor, stone_charge_minor, tax_minor, discount_minor,
         chit_applied_minor, unused_chit_minor, final_payable_minor, items_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(chitId, saleId, date, p.credit.rate.rateMinor, p.credit.weightMg, p.credit.paidMinor, p.credit.valueMinor,
      sumOf(p.lines, 'metalValueMinor'), sumOf(p.lines, 'makingMinor'), sumOf(p.lines, 'wastageMinor'), sumOf(p.lines, 'stoneMinor'),
      p.taxMinor, p.discountMinor, p.appliedMinor, p.unusedMinor, p.finalPayableMinor, JSON.stringify(api.items), createdBy);
    db.prepare(`UPDATE chits SET status = 'REDEEMED', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(chitId);
    logEvent(db, chitId, 'REDEEMED', { ...api, saleId }, createdBy);
    recordAudit(db, { userId: createdBy, action: 'CHIT_REDEEM', entityType: 'chit', entityId: chitId, previousState: { status: 'ACTIVE' }, newState: { status: 'REDEEMED', saleId, ...api } });
  });
  run();
  return getChit(chitId);
}

/** Settlement defaults on cancellation: all the gold, or that gold valued at the cancellation-date rate. */
export function previewCancellation(chitId, { cancellationDate, ratePerGram } = {}) {
  const db = getDb();
  const chit = loadChit(db, chitId);
  const date = cancellationDate ?? todayStr();
  if (!isDate(date)) throw new ValidationError('cancellationDate must be a valid YYYY-MM-DD date.', { field: 'cancellationDate' });
  const c = chitCredit(db, chit, { date, ratePerGram });
  return {
    cancellationDate: date, totalPaid: fromMinorUnits(c.paidMinor), accumulatedWeightGrams: mgToGrams(c.weightMg),
    ratePerGram: fromMinorUnits(c.rate.rateMinor), rateSource: c.rate.source, cashValue: fromMinorUnits(c.valueMinor),
  };
}

/**
 * Cancels before completion. The settlement actually handed over is recorded
 * as given (it defaults to the full accumulated gold, or its cash value on the
 * cancellation date), together with who approved it.
 */
export function cancelChit(chitId, { cancellationDate, settlementType, settlementAmount, settlementWeightGrams, ratePerGram, approvedBy, reason, processedBy }) {
  if (!['GOLD', 'CASH'].includes(settlementType)) throw new ValidationError('settlementType must be GOLD or CASH.', { field: 'settlementType' });
  const db = getDb();
  const date = cancellationDate ?? todayStr();
  if (!isDate(date)) throw new ValidationError('cancellationDate must be a valid YYYY-MM-DD date.', { field: 'cancellationDate' });
  if (date > todayStr()) throw new ValidationError('cancellationDate cannot be in the future.', { field: 'cancellationDate' });

  const run = db.transaction(() => {
    const chit = loadChit(db, chitId);
    if (chit.status !== 'ACTIVE') throw new ConflictError(`Only an active chit can be cancelled (this one is ${chit.status.toLowerCase()}).`);
    const approver = (approvedBy && String(approvedBy).trim()) || db.prepare('SELECT display_name FROM users WHERE id = ?').get(processedBy)?.display_name || 'Unknown';
    const t = totals(db, chitId);
    let amountMinor = null;
    let weightMg = null;
    let rateMinor = null;
    if (settlementType === 'CASH') {
      const credit = chitCredit(db, chit, { date, ratePerGram });
      rateMinor = credit.rate.rateMinor;
      amountMinor = settlementAmount != null ? toMinorUnits(settlementAmount) : credit.valueMinor;
      if (amountMinor < 0) throw new ValidationError('settlementAmount cannot be negative.', { field: 'settlementAmount' });
    } else {
      weightMg = settlementWeightGrams != null ? gramsToMg(settlementWeightGrams) : t.weightMg;
      if (weightMg < 0) throw new ValidationError('settlementWeightGrams cannot be negative.', { field: 'settlementWeightGrams' });
    }
    db.prepare(
      `INSERT INTO chit_cancellations (chit_id, cancellation_date, total_paid_minor, accumulated_weight_mg, settlement_type,
         settlement_amount_minor, settlement_weight_mg, rate_per_gram_minor, processed_by, approved_by_name, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(chitId, date, t.paidMinor, t.weightMg, settlementType, amountMinor, weightMg, rateMinor, processedBy, approver, reason ?? null);
    db.prepare(`UPDATE chits SET status = 'CANCELLED', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(chitId);
    const detail = {
      cancellationDate: date, totalPaid: fromMinorUnits(t.paidMinor), accumulatedWeightGrams: mgToGrams(t.weightMg), settlementType,
      settlementAmount: amountMinor != null ? fromMinorUnits(amountMinor) : null,
      settlementWeightGrams: weightMg != null ? mgToGrams(weightMg) : null, approvedBy: approver, reason: reason ?? null,
    };
    logEvent(db, chitId, 'CANCELLED', detail, processedBy);
    recordAudit(db, { userId: processedBy, action: 'CHIT_CANCEL', entityType: 'chit', entityId: chitId, previousState: { status: 'ACTIVE' }, newState: { status: 'CANCELLED', ...detail }, reason });
  });
  run();
  return getChit(chitId);
}

export function getChit(id) {
  const db = getDb();
  const chit = db.prepare(
    'SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone FROM chits c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ?'
  ).get(id);
  if (!chit) throw new NotFoundError(`Chit ${id} not found.`);
  const payments = db.prepare('SELECT * FROM chit_payments WHERE chit_id = ? ORDER BY payment_no').all(id);
  const t = totals(db, id);
  const asOf = chit.status === 'ACTIVE' ? todayStr() : (chit.closed_at ?? todayStr()).slice(0, 10);
  const due = installmentsDue(chit.start_date, asOf, chit.duration_months);
  const redemption = db.prepare('SELECT * FROM chit_redemptions WHERE chit_id = ?').get(id);
  const cancellation = db.prepare('SELECT cx.*, u.display_name AS processed_by_name FROM chit_cancellations cx LEFT JOIN users u ON u.id = cx.processed_by WHERE cx.chit_id = ?').get(id);
  const events = db.prepare('SELECT * FROM chit_events WHERE chit_id = ? ORDER BY id').all(id);
  const m = fromMinorUnits;
  return {
    id: chit.id, chitNumber: chit.chit_number, customerId: chit.customer_id, customerName: chit.customer_name, customerPhone: chit.customer_phone,
    startDate: chit.start_date, monthlyAmount: m(chit.monthly_amount_minor), durationMonths: chit.duration_months,
    metal: chit.metal, purity: chit.purity, status: chit.status, closedAt: chit.closed_at,
    totalPaid: m(t.paidMinor), accumulatedWeightGrams: mgToGrams(t.weightMg),
    paymentsMade: t.made, paymentsRemaining: Math.max(0, chit.duration_months - t.made),
    installmentsDue: due, missedPayments: Math.max(0, due - t.made),
    isComplete: t.made >= chit.duration_months,
    payments: payments.map((p) => ({
      id: p.id, paymentNo: p.payment_no, paymentDate: p.payment_date, amount: m(p.amount_minor), ratePerGram: m(p.rate_per_gram_minor),
      rateSource: p.rate_source, goldWeightGrams: mgToGrams(p.gold_weight_mg), method: p.method, reference: p.reference, recordedAt: p.created_at,
    })),
    redemption: redemption && {
      saleId: redemption.sale_id, redemptionDate: redemption.redemption_date, ratePerGram: m(redemption.rate_per_gram_minor), accumulatedWeightGrams: mgToGrams(redemption.accumulated_weight_mg),
      totalPaid: m(redemption.total_paid_minor), chitValue: m(redemption.chit_value_minor), items: JSON.parse(redemption.items_json),
      jewelleryValue: m(redemption.jewellery_value_minor), makingCharge: m(redemption.making_charge_minor), wastage: m(redemption.wastage_minor),
      stoneCharge: m(redemption.stone_charge_minor), tax: m(redemption.tax_minor), discount: m(redemption.discount_minor),
      chitApplied: m(redemption.chit_applied_minor), unusedChitValue: m(redemption.unused_chit_minor), finalPayable: m(redemption.final_payable_minor),
    },
    cancellation: cancellation && {
      cancellationDate: cancellation.cancellation_date, totalPaid: m(cancellation.total_paid_minor), accumulatedWeightGrams: mgToGrams(cancellation.accumulated_weight_mg),
      settlementType: cancellation.settlement_type,
      settlementAmount: cancellation.settlement_amount_minor != null ? m(cancellation.settlement_amount_minor) : null,
      settlementWeightGrams: cancellation.settlement_weight_mg != null ? mgToGrams(cancellation.settlement_weight_mg) : null,
      ratePerGram: cancellation.rate_per_gram_minor != null ? m(cancellation.rate_per_gram_minor) : null,
      processedBy: cancellation.processed_by, processedByName: cancellation.processed_by_name, approvedBy: cancellation.approved_by_name, reason: cancellation.reason,
    },
    events: events.map((e) => ({ type: e.event_type, details: e.details_json ? JSON.parse(e.details_json) : null, at: e.created_at, by: e.created_by })),
  };
}

/** `q` matches a chit number, or a customer phone number (digits only, partial match, needs 3+ digits). */
export function listChits({ q, customerId, status, limit = 100, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (customerId) { clauses.push('c.customer_id = ?'); params.push(customerId); }
  if (status) { clauses.push('c.status = ?'); params.push(status); }
  const term = q ? String(q).trim() : '';
  if (term) {
    const digits = term.replace(/\D/g, '');
    const phoneExpr = "REPLACE(REPLACE(REPLACE(COALESCE(cu.phone, ''), ' ', ''), '-', ''), '+', '')";
    if (digits.length >= 3) {
      clauses.push(`(c.chit_number LIKE ? COLLATE NOCASE OR ${phoneExpr} LIKE ?)`);
      params.push(`%${term}%`, `%${digits}%`);
    } else {
      clauses.push('c.chit_number LIKE ? COLLATE NOCASE');
      params.push(`%${term}%`);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  return db.prepare(`SELECT c.id FROM chits c JOIN customers cu ON cu.id = c.customer_id ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(...params).map((r) => getChit(r.id));
}
