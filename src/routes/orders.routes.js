import { Router } from 'express';
import { createOrder, getOrder, listOrders, transitionOrder, linkSale } from '../modules/orders/order.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const ordersRouter = Router();

ordersRouter.get('/', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json({ data: listOrders({ customerId: req.query.customerId, status: req.query.status, limit, offset }), limit, offset });
}));

ordersRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getOrder(req.params.id));
}));

ordersRouter.post('/', requireAuth, requirePermission('order.create'), asyncRoute((req, res) => {
  res.status(201).json(createOrder({ ...req.body, createdBy: req.user.id }));
}));

ordersRouter.post('/:id/transitions', requireAuth, asyncRoute((req, res) => {
  if (req.body?.toStatus === 'CANCELLED' && !req.permissions.has('order.cancel')) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing permission: order.cancel' });
  }
  res.json(transitionOrder(req.params.id, { toStatus: req.body?.toStatus, reason: req.body?.reason, userId: req.user.id }));
}));

ordersRouter.post('/:id/link-sale', requireAuth, requirePermission('order.create'), asyncRoute((req, res) => {
  res.json(linkSale(req.params.id, { saleId: req.body?.saleId, userId: req.user.id }));
}));
