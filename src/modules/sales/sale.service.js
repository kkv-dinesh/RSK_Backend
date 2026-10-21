import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { fromMinorUnits } from '../../lib/money.js';
import { priceSaleLine, calculateDiscount, calculateTax, calculateFinalAmount, makingChargeRateForWeight, settleShortfallAsDiscount } from './pricing.service.js';
import { recordMovement } from '../stock/stock.service.js';
import { appendLedgerEntry } from '../customers/customer.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { normalizePaymentMethod, DEFAULT_PAYMENT_METHOD } from '../../lib/paymentMethods.js';

/**
 * Creates a sale: validates item availability, prices every line on the
 * backend only, marks each tagged item SOLD exactly once, writes the stock
 * ledger, the customer ledger, and (optionally) an initial payment —
 * all inside one transaction (spec §4.4, §6.2).
 */
export function createSale({ customerId, items, discount = 0, tax = 0, payment, settleShortfall = false, createdBy }) {
  if (!customerId) throw new ValidationError('customerId is required.');
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('At least one item line is required.');

  const db = getDb();
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new NotFoundError(`Customer ${customerId} not found.`);

  const run = db.transaction(() => {
    const saleResult = db
      .prepare(
        `INSERT INTO sales (customer_id, status, subtotal_minor, discount_minor, tax_minor, total_minor, created_by)
         VALUES (?, 'COMPLETED', 0, 0, 0, 0, ?)`
      )
      .run(customerId, createdBy);
    const saleId = saleResult.lastInsertRowid;

    let subtotalMinor = 0;
    const lineRows = [];

    for (const line of items) {
      const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(line.inventoryItemId);
      if (!item) throw new NotFoundError(`Inventory item ${line.inventoryItemId} not found.`);
      // Core invariant: a tagged physical item cannot be sold twice.
      if (item.status !== 'IN_STOCK') {
        throw new ConflictError(`Item ${item.tag_id} is not available for sale (status: ${item.status}).`);
      }
      if (!Number.isFinite(line.ratePerGram) || line.ratePerGram <= 0) {
        throw new ValidationError('ratePerGram must be a positive number for every item line.');
      }

      const ratePerGramMinor = Math.round(line.ratePerGram * 100);
      const priced = priceSaleLine({
        netWeightMg: item.net_weight_mg,
        ratePerGramMinor,
        wastageChargeMinor: Math.round((line.wastageCharge ?? 0) * 100),
        stoneChargeMinor: Math.round((line.stoneCharge ?? 0) * 100),
      });
      subtotalMinor += priced.lineTotalMinor;

      db.prepare(
        `INSERT INTO sale_items
           (sale_id, inventory_item_id, metal_rate_id, rate_per_gram_minor, net_weight_mg,
            metal_value_minor, making_charge_minor, wastage_charge_minor, stone_charge_minor, line_total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        saleId, item.id, line.metalRateId ?? null, ratePerGramMinor, item.net_weight_mg,
        priced.metalValueMinor, priced.makingChargeMinor, priced.wastageChargeMinor, priced.stoneChargeMinor, priced.lineTotalMinor
      );

      db.prepare('UPDATE inventory_items SET status = \'SOLD\', updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?')
        .run(item.id);

      recordMovement(db, {
        inventoryItemId: item.id,
        movementType: 'SALE_OUT',
        quantityDelta: -1,
        weightDeltaMg: -item.net_weight_mg,
        fromLocationId: item.location_id,
        reason: 'Sale',
        sourceTransaction: `SALE-${saleId}`,
        createdBy,
      });

      lineRows.push({ tagId: item.tag_id, ...priced });
    }

    let discountMinor = calculateDiscount(subtotalMinor, Math.round(discount * 100));
    const taxMinor = calculateTax(Math.round(tax * 100));
    let { totalMinor } = calculateFinalAmount({
      metalValueMinor: subtotalMinor, makingChargeMinor: 0, wastageChargeMinor: 0, stoneChargeMinor: 0, discountMinor, taxMinor,
    });
    let autoDiscountMinor = 0;
    if (settleShortfall) {
      ({ discountMinor, autoDiscountMinor, totalMinor } = settleShortfallAsDiscount({
        subtotalMinor, discountMinor, taxMinor, receivedMinor: Math.round((payment?.amount ?? 0) * 100),
      }));
    }

    db.prepare('UPDATE sales SET subtotal_minor = ?, discount_minor = ?, auto_discount_minor = ?, tax_minor = ?, total_minor = ? WHERE id = ?')
      .run(subtotalMinor, discountMinor, autoDiscountMinor, taxMinor, totalMinor, saleId);

    appendLedgerEntry(db, {
      customerId, entryType: 'INVOICE', amountMinor: totalMinor, sourceTransaction: `SALE-${saleId}`, createdBy,
    });

    recordAudit(db, {
      userId: createdBy,
      action: 'SALE_CREATE',
      entityType: 'sale',
      entityId: saleId,
      newState: { customerId, totalMinor, discountMinor, autoDiscountMinor, itemCount: lineRows.length },
      sourceTransaction: `SALE-${saleId}`,
    });

    if (payment?.amount > 0) {
      recordPaymentWithinTransaction(db, {
        customerId,
        saleId,
        amountMinor: Math.round(payment.amount * 100),
        method: payment.method ?? DEFAULT_PAYMENT_METHOD,
        reference: payment.reference ?? null,
        createdBy,
      });
    }

    return saleId;
  });

  const saleId = run();
  return getSale(saleId);
}

/**
 * Prices a prospective sale exactly as createSale would, without writing
 * anything. The UI shows this so staff review the real figures before confirming.
 */
export function previewSale({ items, discount = 0, tax = 0, payAmount = 0, settleShortfall = false }) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Add at least one item.');
  const db = getDb();
  const seen = new Set();
  let subtotalMinor = 0;
  const lines = items.map((line) => {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(line.inventoryItemId);
    if (!item) throw new NotFoundError(`Inventory item ${line.inventoryItemId} not found.`);
    if (seen.has(item.id)) throw new ConflictError(`Item ${item.tag_id} is added twice.`);
    seen.add(item.id);
    if (item.status !== 'IN_STOCK') throw new ConflictError(`Item ${item.tag_id} is not available for sale (status: ${item.status}).`);
    if (!Number.isFinite(line.ratePerGram) || line.ratePerGram <= 0) throw new ValidationError('ratePerGram must be a positive number for every item line.');
    const priced = priceSaleLine({
      netWeightMg: item.net_weight_mg,
      ratePerGramMinor: Math.round(line.ratePerGram * 100),
      wastageChargeMinor: Math.round((line.wastageCharge ?? 0) * 100),
      stoneChargeMinor: Math.round((line.stoneCharge ?? 0) * 100),
    });
    subtotalMinor += priced.lineTotalMinor;
    return {
      inventoryItemId: item.id, tagId: item.tag_id, netWeightGrams: item.net_weight_mg / 1000,
      ratePerGram: line.ratePerGram, makingChargePercent: Math.round(makingChargeRateForWeight(item.net_weight_mg) * 100),
      metalValue: fromMinorUnits(priced.metalValueMinor), makingCharge: fromMinorUnits(priced.makingChargeMinor),
      wastageCharge: fromMinorUnits(priced.wastageChargeMinor), stoneCharge: fromMinorUnits(priced.stoneChargeMinor),
      lineTotal: fromMinorUnits(priced.lineTotalMinor),
    };
  });
  let discountMinor = calculateDiscount(subtotalMinor, Math.round(discount * 100));
  const taxMinor = calculateTax(Math.round(tax * 100));
  let { totalMinor } = calculateFinalAmount({
    metalValueMinor: subtotalMinor, makingChargeMinor: 0, wastageChargeMinor: 0, stoneChargeMinor: 0, discountMinor, taxMinor,
  });
  const enteredDiscountMinor = discountMinor;
  const receivedMinor = Math.round(payAmount * 100);
  let autoDiscountMinor = 0;
  if (settleShortfall && receivedMinor > 0) {
    ({ discountMinor, autoDiscountMinor, totalMinor } = settleShortfallAsDiscount({ subtotalMinor, discountMinor, taxMinor, receivedMinor }));
  }
  return {
    lines, subtotal: fromMinorUnits(subtotalMinor), discount: fromMinorUnits(discountMinor),
    enteredDiscount: fromMinorUnits(enteredDiscountMinor), autoDiscount: fromMinorUnits(autoDiscountMinor),
    tax: fromMinorUnits(taxMinor), total: fromMinorUnits(totalMinor),
  };
}

// Shared by createSale's initial payment and the standalone payment route —
// kept here to avoid a circular import with payment.service.js.
export function recordPaymentWithinTransaction(db, { customerId, saleId, amountMinor, method, reference, createdBy }) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError('Payment amount must be a positive amount.');
  }
  const resolvedMethod = normalizePaymentMethod(method);
  const outstanding = saleId != null ? getSaleOutstandingMinor(db, saleId) : null;
  if (outstanding != null && amountMinor > outstanding) {
    // Unless explicitly supported, a payment cannot exceed the outstanding balance (spec §9 pricing engine note).
    throw new ValidationError(`Payment of ${amountMinor} exceeds outstanding balance of ${outstanding} for this sale.`);
  }

  const paymentType = saleId == null ? 'ADVANCE' : outstanding === amountMinor ? 'FULL' : 'PARTIAL';
  const paymentResult = db
    .prepare(
      `INSERT INTO payments (customer_id, amount_minor, method, reference, payment_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(customerId, amountMinor, resolvedMethod, reference, paymentType, createdBy);
  const paymentId = paymentResult.lastInsertRowid;

  if (saleId != null) {
    db.prepare('INSERT INTO payment_allocations (payment_id, sale_id, amount_minor) VALUES (?, ?, ?)')
      .run(paymentId, saleId, amountMinor);
  }

  appendLedgerEntry(db, {
    customerId,
    entryType: 'PAYMENT',
    amountMinor: -amountMinor,
    sourceTransaction: saleId != null ? `PAYMENT-${paymentId}-SALE-${saleId}` : `PAYMENT-${paymentId}-ADVANCE`,
    createdBy,
  });

  recordAudit(db, {
    userId: createdBy,
    action: 'PAYMENT_CREATE',
    entityType: 'payment',
    entityId: paymentId,
    newState: { customerId, saleId, amountMinor, paymentType },
  });

  return paymentId;
}

export function getSaleOutstandingMinor(db, saleId) {
  const sale = db.prepare('SELECT total_minor FROM sales WHERE id = ?').get(saleId);
  if (!sale) throw new NotFoundError(`Sale ${saleId} not found.`);
  const allocated = db
    .prepare(
      `SELECT COALESCE(SUM(pa.amount_minor), 0) AS allocated
       FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
       WHERE pa.sale_id = ? AND p.status = 'COMPLETED'`
    )
    .get(saleId).allocated;
  return sale.total_minor - allocated;
}

export function getSale(id) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) throw new NotFoundError(`Sale ${id} not found.`);
  const items = db
    .prepare(
      `SELECT si.*, ii.tag_id FROM sale_items si JOIN inventory_items ii ON ii.id = si.inventory_item_id
       WHERE si.sale_id = ?`
    )
    .all(id);
  const outstandingMinor = getSaleOutstandingMinor(db, id);
  const customerName = db.prepare('SELECT name FROM customers WHERE id = ?').get(sale.customer_id)?.name ?? null;
  return {
    id: sale.id,
    customerId: sale.customer_id,
    customerName,
    status: sale.status,
    subtotal: fromMinorUnits(sale.subtotal_minor),
    discount: fromMinorUnits(sale.discount_minor),
    autoDiscount: fromMinorUnits(sale.auto_discount_minor),
    tax: fromMinorUnits(sale.tax_minor),
    total: fromMinorUnits(sale.total_minor),
    outstanding: fromMinorUnits(outstandingMinor),
    createdAt: sale.created_at,
    items: items.map((i) => ({
      tagId: i.tag_id,
      netWeightGrams: i.net_weight_mg / 1000,
      ratePerGram: fromMinorUnits(i.rate_per_gram_minor),
      metalValue: fromMinorUnits(i.metal_value_minor),
      makingCharge: fromMinorUnits(i.making_charge_minor),
      wastageCharge: fromMinorUnits(i.wastage_charge_minor),
      stoneCharge: fromMinorUnits(i.stone_charge_minor),
      lineTotal: fromMinorUnits(i.line_total_minor),
      returnedAt: i.returned_at,
    })),
  };
}

export function listSales({ customerId, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (customerId) { clauses.push('customer_id = ?'); params.push(customerId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = db.prepare(`SELECT id FROM sales ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params);
  return rows.map((r) => getSale(r.id));
}

/**
 * Cancels a sale: returns every (not-yet-returned) item to stock, reverses
 * the invoice's ledger effect, and refunds any amount the customer already
 * paid toward it (confirmed rule #6). The original invoice and its line
 * items remain visible; this never deletes them (spec §4.4, §6.2).
 */
export function cancelSale(id, { reason, userId, refundMethod }) {
  if (!reason) throw new ValidationError('A cancellation reason is required.');
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) throw new NotFoundError(`Sale ${id} not found.`);
  if (sale.status === 'CANCELLED') throw new ConflictError('Sale is already cancelled.');

  const run = db.transaction(() => {
    const items = db
      .prepare(
        `SELECT si.id AS sale_item_id, si.inventory_item_id, si.returned_at, ii.net_weight_mg, ii.status
         FROM sale_items si JOIN inventory_items ii ON ii.id = si.inventory_item_id
         WHERE si.sale_id = ?`
      )
      .all(id);

    for (const item of items) {
      if (item.returned_at) continue; // already reversed individually; do not double-reverse
      recordMovement(db, {
        inventoryItemId: item.inventory_item_id,
        movementType: 'CUSTOMER_RETURN_IN',
        quantityDelta: 1,
        weightDeltaMg: item.net_weight_mg,
        reason: `Sale cancellation: ${reason}`,
        sourceTransaction: `SALE-${id}-CANCEL`,
        createdBy: userId,
      });
      db.prepare('UPDATE inventory_items SET status = \'IN_STOCK\', updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?')
        .run(item.inventory_item_id);
      db.prepare('UPDATE sale_items SET returned_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'), returned_by = ? WHERE id = ?')
        .run(userId, item.sale_item_id);
    }

    db.prepare(
      `UPDATE sales SET status = 'CANCELLED', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         cancelled_by = ?, cancel_reason = ? WHERE id = ?`
    ).run(userId, reason, id);

    // Reverse the outstanding (unpaid) portion of the invoice in the ledger —
    // this zeroes out what the sale still contributes to the customer's balance.
    const outstandingMinor = getSaleOutstandingMinor(db, id);
    if (outstandingMinor !== 0) {
      appendLedgerEntry(db, {
        customerId: sale.customer_id,
        entryType: 'REVERSAL',
        amountMinor: -outstandingMinor,
        sourceTransaction: `SALE-${id}-CANCEL`,
        createdBy: userId,
      });
    }

    // Confirmed rule #6: any amount already paid toward this sale is refunded.
    const paidMinor = sale.total_minor - outstandingMinor;
    if (paidMinor > 0) {
      const resolvedMethod = normalizePaymentMethod(refundMethod);
      const refundResult = db
        .prepare(
          `INSERT INTO payments (customer_id, amount_minor, method, reference, payment_type, created_by, refund_for_sale_id)
           VALUES (?, ?, ?, ?, 'REFUND', ?, ?)`
        )
        .run(sale.customer_id, paidMinor, resolvedMethod, `Refund for cancelled SALE-${id}`, userId, id);

      recordAudit(db, {
        userId,
        action: 'SALE_REFUND',
        entityType: 'payment',
        entityId: refundResult.lastInsertRowid,
        newState: { saleId: id, amountMinor: paidMinor, method: resolvedMethod },
        reason,
        sourceTransaction: `SALE-${id}-CANCEL`,
      });
    }

    recordAudit(db, {
      userId,
      action: 'SALE_CANCEL',
      entityType: 'sale',
      entityId: id,
      previousState: { status: sale.status },
      newState: { status: 'CANCELLED' },
      reason,
      sourceTransaction: `SALE-${id}-CANCEL`,
    });
  });

  run();
  return getSale(id);
}
