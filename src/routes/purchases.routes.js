import { Router } from 'express';
import { createPurchase, getPurchase, listPurchases, cancelPurchase, previewPurchase } from '../modules/purchases/purchase.service.js';
import { createSupplier, listSuppliers } from '../modules/purchases/supplier.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const purchasesRouter = Router();

purchasesRouter.get('/', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json({ data: listPurchases({ supplierId: req.query.supplierId, limit, offset }), limit, offset });
}));

purchasesRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getPurchase(req.params.id));
}));

purchasesRouter.post('/preview', requireAuth, requirePermission('purchase.create'), asyncRoute((req, res) => {
  res.json(previewPurchase(req.body ?? {}));
}));

purchasesRouter.post('/', requireAuth, requirePermission('purchase.create'), asyncRoute((req, res) => {
  const purchase = createPurchase({ ...req.body, createdBy: req.user.id });
  res.status(201).json(purchase);
}));

purchasesRouter.post('/:id/cancel', requireAuth, requirePermission('purchase.cancel'), asyncRoute((req, res) => {
  const purchase = cancelPurchase(req.params.id, { reason: req.body?.reason, userId: req.user.id });
  res.json(purchase);
}));

export const suppliersRouter = Router();

suppliersRouter.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listSuppliers() });
}));

suppliersRouter.post('/', requireAuth, requirePermission('purchase.create'), asyncRoute((req, res) => {
  res.status(201).json(createSupplier(req.body ?? {}));
}));
