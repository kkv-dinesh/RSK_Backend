import { Router } from 'express';
import { createSale, getSale, listSales, cancelSale, previewSale } from '../modules/sales/sale.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const salesRouter = Router();

salesRouter.get('/', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json({ data: listSales({ customerId: req.query.customerId, limit, offset }), limit, offset });
}));

salesRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getSale(req.params.id));
}));

// This endpoint is the invoice of record; it is what §4.4 calls "invoice/receipt".
salesRouter.get('/:id/invoice', requireAuth, asyncRoute((req, res) => {
  res.json(getSale(req.params.id));
}));

salesRouter.post('/preview', requireAuth, requirePermission('sale.create'), asyncRoute((req, res) => {
  res.json(previewSale(req.body ?? {}));
}));

salesRouter.post('/', requireAuth, requirePermission('sale.create'), asyncRoute((req, res) => {
  if (req.body?.discount > 0 && !req.permissions.has('discount.apply')) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing permission: discount.apply' });
  }
  const sale = createSale({ ...req.body, createdBy: req.user.id });
  res.status(201).json(sale);
}));

salesRouter.post('/:id/cancel', requireAuth, requirePermission('sale.cancel'), asyncRoute((req, res) => {
  res.json(cancelSale(req.params.id, { reason: req.body?.reason, userId: req.user.id, refundMethod: req.body?.refundMethod }));
}));
