import { getDb } from '../../db/connection.js';
import { fromMinorUnits } from '../../lib/money.js';
import { getSaleOutstandingMinor } from '../sales/sale.service.js';
import { listPledges } from '../pledges/pledge.service.js';

// Read-only summaries. Every figure is computed here from the real tables so
// the UI only ever displays numbers — it never recomputes them.

function rangeClause(column, from, to) {
  const parts = [];
  const params = [];
  if (from) { parts.push(`${column} >= ?`); params.push(from); }
  if (to) { parts.push(`${column} <= ?`); params.push(`${to}T23:59:59.999Z`); }
  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

export function salesReport({ from, to } = {}) {
  const db = getDb();
  const r = rangeClause('s.created_at', from, to);
  const rows = db
    .prepare(
      `SELECT s.id, s.status, s.total_minor, s.created_at, s.customer_id, c.name AS customer_name
       FROM sales s JOIN customers c ON c.id = s.customer_id
       WHERE 1 = 1 ${r.sql} ORDER BY s.id DESC`
    )
    .all(...r.params);

  let invoicedMinor = 0;
  let outstandingMinor = 0;
  let cancelledCount = 0;
  const sales = rows.map((s) => {
    const outstanding = s.status === 'COMPLETED' ? getSaleOutstandingMinor(db, s.id) : 0;
    if (s.status === 'COMPLETED') { invoicedMinor += s.total_minor; outstandingMinor += outstanding; } else cancelledCount += 1;
    return {
      id: s.id, customerId: s.customer_id, customerName: s.customer_name, status: s.status,
      total: fromMinorUnits(s.total_minor), outstanding: fromMinorUnits(outstanding), createdAt: s.created_at,
    };
  });

  const pr = rangeClause('created_at', from, to);
  const byMethod = db
    .prepare(
      `SELECT method, COALESCE(SUM(amount_minor), 0) AS s, COUNT(*) AS n FROM payments
       WHERE status = 'COMPLETED' AND payment_type != 'REFUND' ${pr.sql} GROUP BY method ORDER BY s DESC`
    )
    .all(...pr.params)
    .map((m) => ({ method: m.method, amount: fromMinorUnits(m.s), count: m.n }));
  const refundsMinor = db
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payments WHERE status = 'COMPLETED' AND payment_type = 'REFUND' ${pr.sql}`)
    .get(...pr.params).s;

  return {
    range: { from: from ?? null, to: to ?? null },
    totals: {
      invoiced: fromMinorUnits(invoicedMinor),
      outstanding: fromMinorUnits(outstandingMinor),
      saleCount: rows.length - cancelledCount,
      cancelledCount,
      refunds: fromMinorUnits(refundsMinor),
    },
    byMethod,
    sales,
  };
}

export function purchasesReport({ from, to } = {}) {
  const db = getDb();
  const r = rangeClause('p.created_at', from, to);
  const rows = db
    .prepare(
      `SELECT p.id, p.status, p.total_minor, p.created_at, p.reference, s.name AS supplier_name,
              sp.method AS payment_method
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN supplier_payments sp ON sp.purchase_id = p.id
       WHERE 1 = 1 ${r.sql} ORDER BY p.id DESC`
    )
    .all(...r.params);

  let totalMinor = 0;
  let cancelledCount = 0;
  const byMethod = new Map();
  const bySupplier = new Map();
  for (const p of rows) {
    if (p.status === 'CANCELLED') { cancelledCount += 1; continue; }
    totalMinor += p.total_minor;
    const m = p.payment_method || 'UNPAID';
    byMethod.set(m, (byMethod.get(m) || 0) + p.total_minor);
    bySupplier.set(p.supplier_name, (bySupplier.get(p.supplier_name) || 0) + p.total_minor);
  }

  return {
    range: { from: from ?? null, to: to ?? null },
    totals: { purchased: fromMinorUnits(totalMinor), purchaseCount: rows.length - cancelledCount, cancelledCount },
    byMethod: [...byMethod].map(([method, v]) => ({ method, amount: fromMinorUnits(v) })),
    bySupplier: [...bySupplier].map(([name, v]) => ({ name, amount: fromMinorUnits(v) })).sort((a, b) => b.amount - a.amount),
    purchases: rows.map((p) => ({
      id: p.id, supplierName: p.supplier_name, status: p.status, reference: p.reference,
      total: fromMinorUnits(p.total_minor), paymentMethod: p.payment_method, createdAt: p.created_at,
    })),
  };
}

const AGING_BUCKETS = [
  ['current', 0, 30], ['days31to60', 31, 60], ['days61to90', 61, 90], ['over90', 91, Infinity],
];

/** Outstanding per customer, bucketed by invoice age (days since the invoice date). */
export function creditReport({ now = Date.now() } = {}) {
  const db = getDb();
  const sales = db
    .prepare(
      `SELECT s.id, s.customer_id, s.created_at, c.name AS customer_name, c.phone
       FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.status = 'COMPLETED' ORDER BY s.created_at`
    )
    .all();

  const customers = new Map();
  for (const s of sales) {
    const outstanding = getSaleOutstandingMinor(db, s.id);
    if (outstanding <= 0) continue;
    const ageDays = Math.floor((now - new Date(s.created_at).getTime()) / 86400000);
    const bucket = AGING_BUCKETS.find(([, lo, hi]) => ageDays >= lo && ageDays <= hi)[0];
    const row = customers.get(s.customer_id) || {
      customerId: s.customer_id, customerName: s.customer_name, phone: s.phone,
      outstandingMinor: 0, oldestInvoiceDate: s.created_at, invoiceCount: 0,
      buckets: { current: 0, days31to60: 0, days61to90: 0, over90: 0 },
    };
    row.outstandingMinor += outstanding;
    row.invoiceCount += 1;
    row.buckets[bucket] += outstanding;
    customers.set(s.customer_id, row);
  }

  const list = [...customers.values()].sort((a, b) => b.outstandingMinor - a.outstandingMinor);
  const buckets = { current: 0, days31to60: 0, days61to90: 0, over90: 0 };
  let totalMinor = 0;
  for (const c of list) {
    totalMinor += c.outstandingMinor;
    for (const k of Object.keys(buckets)) buckets[k] += c.buckets[k];
  }
  const money = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fromMinorUnits(v)]));
  return {
    totals: { outstanding: fromMinorUnits(totalMinor), customerCount: list.length, buckets: money(buckets) },
    customers: list.map((c) => ({
      customerId: c.customerId, customerName: c.customerName, phone: c.phone,
      outstanding: fromMinorUnits(c.outstandingMinor), oldestInvoiceDate: c.oldestInvoiceDate,
      invoiceCount: c.invoiceCount, buckets: money(c.buckets),
    })),
  };
}

export function pledgesReport() {
  const pledges = listPledges({ limit: 1000 });
  const totals = { activeCount: 0, settledCount: 0, activePrincipal: 0, interestOutstanding: 0, principalOutstanding: 0 };
  for (const p of pledges) {
    if (p.status === 'ACTIVE') {
      totals.activeCount += 1;
      totals.activePrincipal += p.principal;
      totals.interestOutstanding += p.interestOutstanding;
      totals.principalOutstanding += p.principalOutstanding;
    } else if (p.status === 'SETTLED') totals.settledCount += 1;
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  totals.activePrincipal = round2(totals.activePrincipal);
  totals.interestOutstanding = round2(totals.interestOutstanding);
  totals.principalOutstanding = round2(totals.principalOutstanding);
  return { totals, pledges };
}
