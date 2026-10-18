import { Router } from 'express';
import { itemLedger, reconcileItem, adjustWeight, listAvailableItems, listItems, listMovements } from '../modules/stock/stock.service.js';
import { getDb } from '../db/connection.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';
import { gramsToMilligrams } from '../modules/catalog/units.js';

export const stockRouter = Router();

stockRouter.get('/items', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { status, metal, category, q } = req.query;
  res.json({ ...listItems({ status, metal, category, q, limit, offset }), limit, offset });
}));

stockRouter.get('/movements', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { type, q, from, to } = req.query;
  res.json({ ...listMovements({ type, q, from, to, limit, offset }), limit, offset });
}));

stockRouter.get('/available-items', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listAvailableItems() });
}));

stockRouter.get('/items/:id/movements', requireAuth, asyncRoute((req, res) => {
  res.json({ data: itemLedger(req.params.id) });
}));

stockRouter.get('/items/:id/reconcile', requireAuth, asyncRoute((req, res) => {
  res.json(reconcileItem(req.params.id));
}));

stockRouter.post('/items/:id/adjust', requireAuth, requirePermission('stock.adjust'), asyncRoute((req, res) => {
  const db = getDb();
  const newNetWeightMg = gramsToMilligrams(Number(req.body?.newNetWeightGrams));
  const movement = db.transaction(() =>
    adjustWeight(db, {
      inventoryItemId: req.params.id,
      newNetWeightMg,
      reason: req.body?.reason,
      createdBy: req.user.id,
    })
  )();
  res.status(201).json(movement);
}));
