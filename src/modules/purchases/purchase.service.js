import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { validateWeights } from '../catalog/units.js';
import { toMinorUnits, fromMinorUnits } from '../../lib/money.js';
import { generateTagId, recordMovement } from '../stock/stock.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { normalizePaymentMethod } from '../../lib/paymentMethods.js';

/**
 * Creates a purchase with one or more item lines. Each line creates exactly
 * one inventory item and exactly one PURCHASE_IN stock movement. The whole
 * operation commits or rolls back as a unit (spec §4.3, §6.2).
 *
 * Confirmed rule #4: the supplier is paid in full, immediately, at purchase
 * time — there is no supplier credit/outstanding-balance concept — so every
 * purchase records exactly one matching supplier_payments row in the same
 * transaction.
 */
export function createPurchase({ supplierId, reference, items, paymentMethod, paymentReference, createdBy }) {
  if (!supplierId) throw new ValidationError('supplierId is required.');
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('At least one item line is required.');

  const db = getDb();
  const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) throw new NotFoundError(`Supplier ${supplierId} not found.`);

  const run = db.transaction(() => {
    const purchaseResult = db
      .prepare('INSERT INTO purchases (supplier_id, reference, total_minor, created_by) VALUES (?, ?, 0, ?)')
      .run(supplierId, reference ?? null, createdBy);
    const purchaseId = purchaseResult.lastInsertRowid;

    let totalMinor = 0;
    const createdItems = [];

    for (const line of items) {
      const { grossMg, stoneMg, netMg } = validateWeights({ gross: line.gross, stone: line.stone ?? 0, net: line.net });
      if (!Number.isFinite(line.ratePerGram) || line.ratePerGram <= 0) {
        throw new ValidationError('ratePerGram must be a positive number for every item line.');
      }
      const tagId = generateTagId(db, { metal: line.metal, category: line.category });
      const itemResult = db
        .prepare(
          `INSERT INTO inventory_items
             (tag_id, design_id, category, metal, purity, gross_weight_mg, stone_weight_mg, net_weight_mg, location_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN_STOCK')`
        )
        .run(tagId, line.designId ?? null, line.category, line.metal, line.purity, grossMg, stoneMg, netMg, line.locationId ?? null);
      const inventoryItemId = itemResult.lastInsertRowid;

      const rateMinor = toMinorUnits(line.ratePerGram);
      const lineTotalMinor = purchaseLineTotalMinor(rateMinor, netMg);
      totalMinor += lineTotalMinor;

      db.prepare(
        `INSERT INTO purchase_items (purchase_id, inventory_item_id, rate_per_gram_minor, line_total_minor, metal_rate_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(purchaseId, inventoryItemId, rateMinor, lineTotalMinor, line.metalRateId ?? null);

      recordMovement(db, {
        inventoryItemId,
        movementType: 'PURCHASE_IN',
        quantityDelta: 1,
        weightDeltaMg: netMg,
        toLocationId: line.locationId ?? null,
        reason: 'New stock inward (purchase)',
        sourceTransaction: `PURCHASE-${purchaseId}`,
        createdBy,
      });

      createdItems.push({ inventoryItemId, tagId });
    }

    db.prepare('UPDATE purchases SET total_minor = ? WHERE id = ?').run(totalMinor, purchaseId);

    recordAudit(db, {
      userId: createdBy,
      action: 'PURCHASE_CREATE',
      entityType: 'purchase',
      entityId: purchaseId,
      newState: { supplierId, totalMinor, itemCount: createdItems.length },
      sourceTransaction: `PURCHASE-${purchaseId}`,
    });

    if (totalMinor > 0) {
      const resolvedMethod = normalizePaymentMethod(paymentMethod);
      db.prepare(
        `INSERT INTO supplier_payments (supplier_id, purchase_id, amount_minor, method, reference, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(supplierId, purchaseId, totalMinor, resolvedMethod, paymentReference ?? null, createdBy);

      recordAudit(db, {
        userId: createdBy,
        action: 'SUPPLIER_PAYMENT_CREATE',
        entityType: 'purchase',
        entityId: purchaseId,
        newState: { supplierId, amountMinor: totalMinor, method: resolvedMethod },
        sourceTransaction: `PURCHASE-${purchaseId}`,
      });
    }

    return purchaseId;
  });

  const purchaseId = run();
  return getPurchase(purchaseId);
}

/** Same per-line maths createPurchase uses, so the preview can't disagree with the saved total. */
export function purchaseLineTotalMinor(rateMinor, netMg) {
  return Math.round((rateMinor * netMg) / 1000);
}

/** Prices a prospective purchase without writing anything. */
export function previewPurchase({ items }) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Add at least one item.');
  let totalMinor = 0;
  const lines = items.map((line) => {
    const { grossMg, stoneMg, netMg } = validateWeights({ gross: line.gross, stone: line.stone ?? 0, net: line.net });
    if (!Number.isFinite(line.ratePerGram) || line.ratePerGram <= 0) throw new ValidationError('ratePerGram must be a positive number for every item line.');
    const lineTotalMinor = purchaseLineTotalMinor(toMinorUnits(line.ratePerGram), netMg);
    totalMinor += lineTotalMinor;
    return { grossWeightGrams: grossMg / 1000, stoneWeightGrams: stoneMg / 1000, netWeightGrams: netMg / 1000, ratePerGram: line.ratePerGram, lineTotal: fromMinorUnits(lineTotalMinor) };
  });
  return { lines, total: fromMinorUnits(totalMinor) };
}

export function getPurchase(id) {
  const db = getDb();
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) throw new NotFoundError(`Purchase ${id} not found.`);
  const items = db
    .prepare(
      `SELECT pi.*, ii.tag_id, ii.category, ii.metal, ii.purity, ii.net_weight_mg
       FROM purchase_items pi JOIN inventory_items ii ON ii.id = pi.inventory_item_id
       WHERE pi.purchase_id = ?`
    )
    .all(id);
  const supplierPayment = db.prepare('SELECT * FROM supplier_payments WHERE purchase_id = ?').get(id);
  return toApi(purchase, items, supplierPayment);
}

export function listPurchases({ supplierId, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (supplierId) { clauses.push('supplier_id = ?'); params.push(supplierId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = db.prepare(`SELECT * FROM purchases ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params);
  return rows.map((p) => toApi(p, [], db.prepare('SELECT * FROM supplier_payments WHERE purchase_id = ?').get(p.id)));
}

/**
 * Cancellation preserves the original purchase and creates traceable
 * reversing stock movements. Rejected if any item has already left stock
 * (e.g. sold), since that would hide what actually happened to it.
 */
export function cancelPurchase(id, { reason, userId }) {
  if (!reason) throw new ValidationError('A cancellation reason is required.');
  const db = getDb();
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) throw new NotFoundError(`Purchase ${id} not found.`);
  if (purchase.status === 'CANCELLED') throw new ConflictError('Purchase is already cancelled.');

  const run = db.transaction(() => {
    const items = db
      .prepare(
        `SELECT pi.inventory_item_id, ii.status, ii.net_weight_mg
         FROM purchase_items pi JOIN inventory_items ii ON ii.id = pi.inventory_item_id
         WHERE pi.purchase_id = ?`
      )
      .all(id);

    for (const item of items) {
      if (item.status !== 'IN_STOCK') {
        throw new ConflictError(
          `Cannot cancel purchase ${id}: item ${item.inventory_item_id} is no longer in stock (status ${item.status}).`
        );
      }
    }

    for (const item of items) {
      const original = db
        .prepare(
          `SELECT * FROM stock_movements
           WHERE inventory_item_id = ? AND movement_type = 'PURCHASE_IN' AND source_transaction = ?`
        )
        .get(item.inventory_item_id, `PURCHASE-${id}`);

      recordMovement(db, {
        inventoryItemId: item.inventory_item_id,
        movementType: 'REVERSAL',
        quantityDelta: -1,
        weightDeltaMg: -item.net_weight_mg,
        fromLocationId: original?.to_location_id ?? null,
        reason: `Purchase cancellation: ${reason}`,
        sourceTransaction: `PURCHASE-${id}-CANCEL`,
        reversedMovementId: original?.id ?? null,
        createdBy: userId,
      });

      db.prepare('UPDATE inventory_items SET status = \'REMOVED\', updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?')
        .run(item.inventory_item_id);
    }

    db.prepare(
      `UPDATE purchases SET status = 'CANCELLED', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         cancelled_by = ?, cancel_reason = ? WHERE id = ?`
    ).run(userId, reason, id);

    recordAudit(db, {
      userId,
      action: 'PURCHASE_CANCEL',
      entityType: 'purchase',
      entityId: id,
      previousState: { status: purchase.status },
      newState: { status: 'CANCELLED' },
      reason,
      sourceTransaction: `PURCHASE-${id}-CANCEL`,
    });
  });

  run();
  return getPurchase(id);
}

function toApi(row, items, supplierPayment) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    reference: row.reference,
    status: row.status,
    totalAmount: fromMinorUnits(row.total_minor),
    createdBy: row.created_by,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    supplierPayment: supplierPayment
      ? { amount: fromMinorUnits(supplierPayment.amount_minor), method: supplierPayment.method, reference: supplierPayment.reference, paidAt: supplierPayment.created_at }
      : null,
    items: items.map((i) => ({
      inventoryItemId: i.inventory_item_id,
      tagId: i.tag_id,
      category: i.category,
      metal: i.metal,
      purity: i.purity,
      netWeightGrams: i.net_weight_mg / 1000,
      ratePerGram: fromMinorUnits(i.rate_per_gram_minor),
      lineTotal: fromMinorUnits(i.line_total_minor),
    })),
  };
}
