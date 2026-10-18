import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { recordAudit } from '../audit/audit.service.js';

const METAL_CODES = { GOLD: 'G', SILVER: 'S', PLATINUM: 'P' };
const CATEGORY_CODES = { RING: 'R', CHAIN: 'C', BANGLE: 'B', NECKLACE: 'N', EARRING: 'E', BRACELET: 'BR' };

export function generateTagId(db, { metal, category }) {
  const metalCode = METAL_CODES[String(metal).toUpperCase()] || String(metal).charAt(0).toUpperCase();
  const categoryCode = CATEGORY_CODES[String(category).toUpperCase()] || String(category).slice(0, 2).toUpperCase();
  const row = db.prepare('SELECT COUNT(*) AS n FROM inventory_items').get();
  const serial = row.n + 1;
  return `${metalCode}-${categoryCode}-${String(serial).padStart(6, '0')}`;
}

/** Records one ledger row inside the caller's transaction. Never called standalone outside a db.transaction(). */
export function recordMovement(db, {
  inventoryItemId, movementType, quantityDelta, weightDeltaMg,
  fromLocationId = null, toLocationId = null, reason, sourceTransaction = null,
  reversedMovementId = null, createdBy,
}) {
  if (!reason) throw new ValidationError('Every stock movement requires a reason.');
  const result = db
    .prepare(
      `INSERT INTO stock_movements
         (inventory_item_id, movement_type, quantity_delta, weight_delta_mg,
          from_location_id, to_location_id, reason, source_transaction, reversed_movement_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      inventoryItemId, movementType, quantityDelta, weightDeltaMg,
      fromLocationId, toLocationId, reason, sourceTransaction, reversedMovementId, createdBy
    );
  return db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(result.lastInsertRowid);
}

/** Items available to pick for a new sale/order — intentionally open to any authenticated staff, not gated behind reports.view. */
export function listAvailableItems() {
  return getDb()
    .prepare(
      `SELECT id, tag_id, category, metal, purity, net_weight_mg FROM inventory_items
       WHERE status = 'IN_STOCK' ORDER BY category, metal, purity`
    )
    .all()
    .map((r) => ({ id: r.id, tagId: r.tag_id, category: r.category, metal: r.metal, purity: r.purity, netWeightGrams: r.net_weight_mg / 1000 }));
}

/** Full register of tagged items (any status) with optional filters; one page at a time. */
export function listItems({ status, metal, category, q, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('ii.status = ?'); params.push(status); }
  if (metal) { clauses.push('ii.metal = ?'); params.push(metal); }
  if (category) { clauses.push('ii.category = ?'); params.push(category); }
  if (q) { clauses.push('ii.tag_id LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM inventory_items ii ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT ii.*, l.name AS location_name FROM inventory_items ii
       LEFT JOIN locations l ON l.id = ii.location_id ${where} ORDER BY ii.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return {
    total,
    data: rows.map((r) => ({
      id: r.id, tagId: r.tag_id, category: r.category, metal: r.metal, purity: r.purity, status: r.status,
      grossWeightGrams: r.gross_weight_mg / 1000, stoneWeightGrams: r.stone_weight_mg / 1000, netWeightGrams: r.net_weight_mg / 1000,
      locationId: r.location_id, locationName: r.location_name, createdAt: r.created_at,
    })),
  };
}

/** Global movement ledger across all items, newest first. */
export function listMovements({ type, q, from, to, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (type) { clauses.push('sm.movement_type = ?'); params.push(type); }
  if (q) { clauses.push('ii.tag_id LIKE ?'); params.push(`%${q}%`); }
  if (from) { clauses.push('sm.created_at >= ?'); params.push(from); }
  if (to) { clauses.push('sm.created_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM stock_movements sm JOIN inventory_items ii ON ii.id = sm.inventory_item_id ${where}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT sm.*, ii.tag_id, u.display_name AS created_by_name
       FROM stock_movements sm
       JOIN inventory_items ii ON ii.id = sm.inventory_item_id
       LEFT JOIN users u ON u.id = sm.created_by
       ${where} ORDER BY sm.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return {
    total,
    data: rows.map((r) => ({
      id: r.id, inventoryItemId: r.inventory_item_id, tagId: r.tag_id, movementType: r.movement_type,
      quantityDelta: r.quantity_delta, weightDeltaGrams: r.weight_delta_mg / 1000, reason: r.reason,
      sourceTransaction: r.source_transaction, createdByName: r.created_by_name, createdAt: r.created_at,
    })),
  };
}

export function itemLedger(inventoryItemId) {
  return getDb()
    .prepare('SELECT * FROM stock_movements WHERE inventory_item_id = ? ORDER BY id')
    .all(inventoryItemId);
}

/**
 * Reconciles an item's current weight/quantity against the sum of its ledger
 * movements (opening balance is implicitly zero — every item is created by a
 * PURCHASE_IN movement, never inserted with a pre-existing balance).
 */
export function reconcileItem(inventoryItemId) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(inventoryItemId);
  if (!item) throw new NotFoundError(`Inventory item ${inventoryItemId} not found.`);
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_delta), 0) AS qty, COALESCE(SUM(weight_delta_mg), 0) AS weightMg
       FROM stock_movements WHERE inventory_item_id = ?`
    )
    .get(inventoryItemId);
  const ledgerQuantity = totals.qty > 0 ? 1 : 0; // a tagged item is in stock (1) or not (0)
  return {
    itemId: item.id,
    tagId: item.tag_id,
    currentNetWeightMg: item.net_weight_mg,
    ledgerNetWeightMg: totals.weightMg,
    matchesWeight: item.net_weight_mg === totals.weightMg,
    currentInStock: item.status === 'IN_STOCK',
    ledgerInStock: ledgerQuantity === 1,
    matchesStock: (item.status === 'IN_STOCK') === (ledgerQuantity === 1),
  };
}

/** Weight-correction adjustment. Requires stock.adjust permission at the route layer. */
export function adjustWeight(db, { inventoryItemId, newNetWeightMg, reason, createdBy }) {
  if (!reason) throw new ValidationError('A stock adjustment requires a reason.');
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(inventoryItemId);
  if (!item) throw new NotFoundError(`Inventory item ${inventoryItemId} not found.`);
  if (item.status !== 'IN_STOCK') throw new ConflictError('Only an in-stock item can be adjusted.');

  const deltaMg = newNetWeightMg - item.net_weight_mg;
  if (deltaMg === 0) throw new ValidationError('Adjustment produces no change; nothing to record.');

  db.prepare('UPDATE inventory_items SET net_weight_mg = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?')
    .run(newNetWeightMg, inventoryItemId);

  const movement = recordMovement(db, {
    inventoryItemId,
    movementType: 'ADJUSTMENT',
    quantityDelta: 0,
    weightDeltaMg: deltaMg,
    reason,
    sourceTransaction: `ADJUSTMENT-ITEM-${inventoryItemId}`,
    createdBy,
  });

  recordAudit(db, {
    userId: createdBy,
    action: 'STOCK_ADJUSTMENT',
    entityType: 'inventory_item',
    entityId: inventoryItemId,
    previousState: { netWeightMg: item.net_weight_mg },
    newState: { netWeightMg: newNetWeightMg },
    reason,
    sourceTransaction: movement.source_transaction,
  });

  return movement;
}
