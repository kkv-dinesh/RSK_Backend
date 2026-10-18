import { Router } from 'express';
import { getDashboard } from '../modules/reports/dashboard.service.js';
import { salesReport, purchasesReport, creditReport, pledgesReport } from '../modules/reports/reports.service.js';
import { getDb } from '../db/connection.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const reportsRouter = Router();

reportsRouter.get('/sales', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  res.json(salesReport({ from: req.query.from, to: req.query.to }));
}));

reportsRouter.get('/purchases', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  res.json(purchasesReport({ from: req.query.from, to: req.query.to }));
}));

reportsRouter.get('/credit', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  res.json(creditReport());
}));

reportsRouter.get('/pledges', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  res.json(pledgesReport());
}));

reportsRouter.get('/dashboard', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  res.json(getDashboard({ startDate: req.query.startDate, endDate: req.query.endDate }));
}));

reportsRouter.get('/stock-on-hand', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT tag_id, category, metal, purity, net_weight_mg, status, location_id
       FROM inventory_items WHERE status = 'IN_STOCK' ORDER BY category, metal, purity`
    )
    .all();
  res.json({ data: rows.map((r) => ({ ...r, netWeightGrams: r.net_weight_mg / 1000 })) });
}));

reportsRouter.get('/cancellations', requireAuth, requirePermission('reports.view'), asyncRoute((req, res) => {
  const db = getDb();
  const purchases = db.prepare("SELECT id, 'PURCHASE' AS type, cancel_reason, cancelled_at FROM purchases WHERE status = 'CANCELLED'").all();
  const sales = db.prepare("SELECT id, 'SALE' AS type, cancel_reason, cancelled_at FROM sales WHERE status = 'CANCELLED'").all();
  const reversedPayments = db.prepare("SELECT id, 'PAYMENT_REVERSAL' AS type, reverse_reason AS cancel_reason, reversed_at AS cancelled_at FROM payments WHERE status = 'REVERSED'").all();
  res.json({ data: [...purchases, ...sales, ...reversedPayments] });
}));
