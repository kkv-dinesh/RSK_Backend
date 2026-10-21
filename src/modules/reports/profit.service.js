import { getDb } from '../../db/connection.js';
import { fromMinorUnits } from '../../lib/money.js';

/**
 * Profit is derived live from the real rows, so it updates itself whenever a
 * purchase or sale is recorded, cancelled, or returned — nothing is stored.
 *
 * Every tagged piece links to the purchase that brought it in
 * (purchase_items), so a sale is matched to the exact purchase batch it came
 * from, however many days apart the purchases were. For each sold piece:
 *   revenue = its sale line total, less its share of the bill discount
 *             (tax is excluded — it is not the shop's income)
 *   cost    = what was paid for the piece at purchase
 *   profit  = revenue - cost
 * Cancelled sales and returned pieces are ignored. Pieces with no purchase
 * record (e.g. opening stock) have no known cost, so they are counted
 * separately and left out of the profit figures instead of inflating them.
 */
export function getProfit({ startDate, endDate, batchLimit = 50 } = {}) {
  const db = getDb();

  const soldRows = db
    .prepare(
      `SELECT si.id AS sale_item_id, si.sale_id, si.inventory_item_id, si.line_total_minor, si.metal_value_minor,
              si.net_weight_mg, s.subtotal_minor, s.discount_minor, s.created_at AS sold_at,
              ii.metal, ii.purity, pi.line_total_minor AS cost_minor, pi.purchase_id
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id AND s.status = 'COMPLETED'
       JOIN inventory_items ii ON ii.id = si.inventory_item_id
       LEFT JOIN purchase_items pi ON pi.inventory_item_id = si.inventory_item_id
         AND EXISTS (SELECT 1 FROM purchases p WHERE p.id = pi.purchase_id AND p.status = 'COMPLETED')
       WHERE si.returned_at IS NULL`
    )
    .all()
    .map((r) => ({
      ...r,
      revenue_minor: r.subtotal_minor > 0
        ? r.line_total_minor - Math.round((r.discount_minor * r.line_total_minor) / r.subtotal_minor)
        : r.line_total_minor,
    }));

  const inRange = (r) => (!startDate || r.sold_at >= startDate) && (!endDate || r.sold_at <= endDate);

  // ----- totals and per-metal view, for sales made inside the period
  const totals = { revenueMinor: 0, costMinor: 0, weightMg: 0, items: 0, itemsWithoutCost: 0 };
  const metals = new Map();
  for (const r of soldRows.filter(inRange)) {
    totals.items += 1;
    if (r.cost_minor == null) { totals.itemsWithoutCost += 1; continue; }
    totals.revenueMinor += r.revenue_minor;
    totals.costMinor += r.cost_minor;
    totals.weightMg += r.net_weight_mg;
    const key = `${r.metal}|${r.purity}`;
    const m = metals.get(key) ?? { metal: r.metal, purity: r.purity, weightMg: 0, revenueMinor: 0, costMinor: 0, metalValueMinor: 0 };
    m.weightMg += r.net_weight_mg; m.revenueMinor += r.revenue_minor; m.costMinor += r.cost_minor; m.metalValueMinor += r.metal_value_minor;
    metals.set(key, m);
  }
  const perGram = (minor, mg) => (mg > 0 ? fromMinorUnits(Math.round((minor * 1000) / mg)) : 0);

  // ----- purchase batches: how much of each purchase has been sold, and what it earned
  const soldByPurchase = new Map();
  for (const r of soldRows) {
    if (r.purchase_id == null) continue;
    const b = soldByPurchase.get(r.purchase_id) ?? { pieces: 0, weightMg: 0, revenueMinor: 0, costMinor: 0 };
    b.pieces += 1; b.weightMg += r.net_weight_mg; b.revenueMinor += r.revenue_minor; b.costMinor += r.cost_minor;
    soldByPurchase.set(r.purchase_id, b);
  }
  const clauses = ["p.status = 'COMPLETED'"];
  const params = [];
  if (startDate) { clauses.push('p.created_at >= ?'); params.push(startDate); }
  if (endDate) { clauses.push('p.created_at <= ?'); params.push(endDate); }
  params.push(batchLimit);
  const batches = db
    .prepare(
      `SELECT p.id, p.reference, p.created_at, su.name AS supplier_name,
              COUNT(pi.id) AS pieces, COALESCE(SUM(ii.net_weight_mg), 0) AS weight_mg, COALESCE(SUM(pi.line_total_minor), 0) AS cost_minor
       FROM purchases p
       JOIN suppliers su ON su.id = p.supplier_id
       JOIN purchase_items pi ON pi.purchase_id = p.id
       JOIN inventory_items ii ON ii.id = pi.inventory_item_id
       WHERE ${clauses.join(' AND ')}
       GROUP BY p.id ORDER BY p.id DESC LIMIT ?`
    )
    .all(...params)
    .map((p) => {
      const sold = soldByPurchase.get(p.id) ?? { pieces: 0, weightMg: 0, revenueMinor: 0, costMinor: 0 };
      return {
        purchaseId: p.id, reference: p.reference, supplierName: p.supplier_name, date: p.created_at,
        piecesBought: p.pieces, gramsBought: p.weight_mg / 1000, cost: fromMinorUnits(p.cost_minor),
        piecesSold: sold.pieces, gramsSold: sold.weightMg / 1000, gramsRemaining: (p.weight_mg - sold.weightMg) / 1000,
        revenue: fromMinorUnits(sold.revenueMinor), costOfSold: fromMinorUnits(sold.costMinor),
        profit: fromMinorUnits(sold.revenueMinor - sold.costMinor),
        status: sold.pieces === 0 ? 'UNSOLD' : sold.pieces >= p.pieces ? 'SOLD_OUT' : 'PARTLY_SOLD',
      };
    });

  return {
    range: { startDate: startDate ?? null, endDate: endDate ?? null },
    revenue: fromMinorUnits(totals.revenueMinor),
    cost: fromMinorUnits(totals.costMinor),
    profit: fromMinorUnits(totals.revenueMinor - totals.costMinor),
    marginPercent: totals.revenueMinor > 0 ? Math.round(((totals.revenueMinor - totals.costMinor) / totals.revenueMinor) * 1000) / 10 : 0,
    gramsSold: totals.weightMg / 1000,
    itemsSold: totals.items,
    itemsWithoutCost: totals.itemsWithoutCost,
    byMetal: [...metals.values()].map((m) => ({
      metal: m.metal, purity: m.purity, gramsSold: m.weightMg / 1000,
      revenue: fromMinorUnits(m.revenueMinor), cost: fromMinorUnits(m.costMinor), profit: fromMinorUnits(m.revenueMinor - m.costMinor),
      avgBuyRatePerGram: perGram(m.costMinor, m.weightMg), avgSellRatePerGram: perGram(m.metalValueMinor, m.weightMg),
    })),
    batches,
  };
}
