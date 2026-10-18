import { getDb } from '../../db/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { recordAudit } from '../audit/audit.service.js';

// Proposed state machine per JEWELLERY_TECHNICAL_SPEC.md §4.6 — subject to
// owner confirmation. ON_HOLD can be entered from any non-terminal state and
// resumes back to the state it was held from (held_from_status).
const TRANSITIONS = {
  DRAFT: ['CONFIRMED', 'IN_PROGRESS', 'CANCELLED', 'ON_HOLD'], // confirmed flow: Order -> Work in progress (CONFIRMED stays available as an optional step)
  CONFIRMED: ['IN_PROGRESS', 'CANCELLED', 'ON_HOLD'],
  IN_PROGRESS: ['READY', 'CANCELLED', 'ON_HOLD'],
  READY: ['DELIVERED', 'CANCELLED', 'ON_HOLD'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  ON_HOLD: [], // resume target comes from held_from_status, handled separately
};
const HOLDABLE = new Set(['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'READY']);

export function createOrder({ customerId, items, expectedDeliveryDate, advance = 0, createdBy }) {
  if (!customerId) throw new ValidationError('customerId is required.');
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('At least one order item is required.');

  const db = getDb();
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) {
    throw new NotFoundError(`Customer ${customerId} not found.`);
  }

  const run = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO orders (customer_id, status, advance_minor, expected_delivery_date, created_by)
         VALUES (?, 'DRAFT', ?, ?, ?)`
      )
      .run(customerId, Math.round(advance * 100), expectedDeliveryDate ?? null, createdBy);
    const orderId = result.lastInsertRowid;

    for (const item of items) {
      if (!item.description) throw new ValidationError('Each order item requires a description.');
      db.prepare(
        `INSERT INTO order_items (order_id, design_id, inventory_item_id, description, estimated_weight_mg, estimated_amount_minor)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        orderId, item.designId ?? null, item.inventoryItemId ?? null, item.description,
        item.estimatedWeightGrams != null ? Math.round(item.estimatedWeightGrams * 1000) : null,
        item.estimatedAmount != null ? Math.round(item.estimatedAmount * 100) : null
      );
    }

    recordAudit(db, { userId: createdBy, action: 'ORDER_CREATE', entityType: 'order', entityId: orderId, newState: { customerId } });
    return orderId;
  });

  return getOrder(run());
}

/** Backend-validated transition. Rejects anything not explicitly allowed from the current state. */
export function transitionOrder(orderId, { toStatus, reason, userId }) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new NotFoundError(`Order ${orderId} not found.`);

  const run = db.transaction(() => {
    let fromStatus = order.status;
    let heldFrom = order.held_from_status;

    if (toStatus === 'ON_HOLD') {
      if (!HOLDABLE.has(order.status)) throw new ConflictError(`Order cannot be put on hold from ${order.status}.`);
      heldFrom = order.status;
    } else if (order.status === 'ON_HOLD' && toStatus === 'RESUME') {
      if (!order.held_from_status) throw new ConflictError('Order has no recorded state to resume to.');
      fromStatus = 'ON_HOLD';
      toStatus = order.held_from_status;
      heldFrom = null;
    } else {
      const allowed = TRANSITIONS[order.status] || [];
      if (!allowed.includes(toStatus)) {
        throw new ConflictError(`Cannot transition order from ${order.status} to ${toStatus}.`);
      }
    }

    db.prepare(
      `UPDATE orders SET status = ?, held_from_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(toStatus, heldFrom, orderId);

    db.prepare(
      `INSERT INTO order_status_history (order_id, from_status, to_status, reason, changed_by) VALUES (?, ?, ?, ?, ?)`
    ).run(orderId, fromStatus, toStatus, reason ?? null, userId);

    recordAudit(db, {
      userId, action: 'ORDER_TRANSITION', entityType: 'order', entityId: orderId,
      previousState: { status: fromStatus }, newState: { status: toStatus }, reason,
    });
  });
  run();
  return getOrder(orderId);
}

/** Links a completed order to an already-created sale. Never auto-creates a sale — that remains a deliberate, separate action (spec §4.6). */
export function linkSale(orderId, { saleId, userId }) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new NotFoundError(`Order ${orderId} not found.`);
  if (!db.prepare('SELECT id FROM sales WHERE id = ?').get(saleId)) throw new NotFoundError(`Sale ${saleId} not found.`);
  db.prepare('UPDATE orders SET sale_id = ? WHERE id = ?').run(saleId, orderId);
  recordAudit(db, { userId, action: 'ORDER_LINK_SALE', entityType: 'order', entityId: orderId, newState: { saleId } });
  return getOrder(orderId);
}

export function getOrder(id) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new NotFoundError(`Order ${id} not found.`);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  const history = db.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id').all(id);
  const customerName = db.prepare('SELECT name FROM customers WHERE id = ?').get(order.customer_id)?.name ?? null;
  return {
    id: order.id,
    customerId: order.customer_id,
    customerName,
    status: order.status,
    advance: order.advance_minor / 100,
    expectedDeliveryDate: order.expected_delivery_date,
    saleId: order.sale_id,
    heldFromStatus: order.held_from_status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    items: items.map((i) => ({
      id: i.id, designId: i.design_id, inventoryItemId: i.inventory_item_id, description: i.description,
      estimatedWeightGrams: i.estimated_weight_mg != null ? i.estimated_weight_mg / 1000 : null,
      estimatedAmount: i.estimated_amount_minor != null ? i.estimated_amount_minor / 100 : null,
    })),
    history: history.map((h) => ({ fromStatus: h.from_status, toStatus: h.to_status, reason: h.reason, changedBy: h.changed_by, at: h.created_at })),
  };
}

export function listOrders({ customerId, status, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (customerId) { clauses.push('customer_id = ?'); params.push(customerId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = db.prepare(`SELECT id FROM orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params);
  return rows.map((r) => getOrder(r.id));
}
