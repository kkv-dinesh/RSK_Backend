import { getDb } from '../../db/connection.js';
import { fromMinorUnits } from '../../lib/money.js';
import { getSaleOutstandingMinor } from '../sales/sale.service.js';
import { getProfit } from './profit.service.js';

/**
 * Every figure here comes from a backend query over real tables — nothing is
 * a hardcoded UI number (spec §4.1). Sales (invoice totals), purchases, and
 * collections (cash actually received) are kept as three distinct metrics,
 * never conflated.
 */
export function getDashboard({ startDate, endDate, includeProfit = false } = {}) {
  const db = getDb();
  const range = dateRangeClause(startDate, endDate);

  const salesTotal = db
    .prepare(`SELECT COALESCE(SUM(total_minor), 0) AS s FROM sales WHERE status = 'COMPLETED' ${range.clause('created_at')}`)
    .get(...range.params).s;

  const purchasesTotal = db
    .prepare(`SELECT COALESCE(SUM(total_minor), 0) AS s FROM purchases WHERE status = 'COMPLETED' ${range.clause('created_at')}`)
    .get(...range.params).s;

  const collectionsTotal = db
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payments WHERE status = 'COMPLETED' ${range.clause('created_at')}`)
    .get(...range.params).s;

  const stockSummary = db
    .prepare(
      `SELECT metal, purity, COUNT(*) AS itemCount, COALESCE(SUM(net_weight_mg), 0) AS totalNetWeightMg
       FROM inventory_items WHERE status = 'IN_STOCK' GROUP BY metal, purity`
    )
    .all()
    .map((r) => ({ metal: r.metal, purity: r.purity, itemCount: r.itemCount, totalNetWeightGrams: r.totalNetWeightMg / 1000 }));

  const customerOutstandingMinor = db
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM customer_ledger_entries`)
    .get().s;

  const openSales = db.prepare(`SELECT id FROM sales WHERE status = 'COMPLETED'`).all();
  const overdueCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  let overdueCount = 0;
  let overdueMinor = 0;
  for (const s of db.prepare(`SELECT id FROM sales WHERE status = 'COMPLETED' AND created_at < ?`).all(overdueCutoff)) {
    const outstanding = getSaleOutstandingMinor(db, s.id);
    if (outstanding > 0) { overdueCount += 1; overdueMinor += outstanding; }
  }

  const orderStatusCounts = db
    .prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  const pendingApprovals = db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'PENDING'").get().n;

  const pledgeExposureMinor = db
    .prepare(`SELECT COALESCE(SUM(principal_minor), 0) AS s FROM pledges WHERE status = 'ACTIVE'`)
    .get().s;

  const recentAudit = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10').all();

  return {
    range: { startDate: startDate ?? null, endDate: endDate ?? null },
    sales: fromMinorUnits(salesTotal),
    purchases: fromMinorUnits(purchasesTotal),
    collections: fromMinorUnits(collectionsTotal),
    stockSummary,
    customerOutstanding: fromMinorUnits(customerOutstandingMinor),
    overdueReceivables: { count: overdueCount, amount: fromMinorUnits(overdueMinor) },
    orderStatusCounts,
    pendingApprovals,
    pledgeExposure: fromMinorUnits(pledgeExposureMinor),
    completedSaleCount: openSales.length,
    profit: includeProfit ? getProfit({ startDate, endDate }) : null,
    recentActivity: recentAudit.map((a) => ({ action: a.action, entityType: a.entity_type, entityId: a.entity_id, at: a.created_at })),
  };
}

function dateRangeClause(startDate, endDate) {
  const params = [];
  if (startDate) params.push(startDate);
  if (endDate) params.push(endDate);
  return {
    params,
    clause(column) {
      const parts = [];
      if (startDate) parts.push(`${column} >= ?`);
      if (endDate) parts.push(`${column} <= ?`);
      return parts.length ? `AND ${parts.join(' AND ')}` : '';
    },
  };
}
