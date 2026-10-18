import { Router } from 'express';
import { recordPayment, getPayment, listPayments, reversePayment } from '../modules/payments/payment.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const paymentsRouter = Router();

paymentsRouter.get('/', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { customerId, method, status, type, from, to } = req.query;
  res.json({ ...listPayments({ customerId, method, status, type, from, to, limit, offset }), limit, offset });
}));

paymentsRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getPayment(req.params.id));
}));

paymentsRouter.post('/', requireAuth, requirePermission('payment.create'), asyncRoute((req, res) => {
  res.status(201).json(recordPayment({ ...req.body, createdBy: req.user.id }));
}));

paymentsRouter.post('/:id/reverse', requireAuth, requirePermission('payment.reverse'), asyncRoute((req, res) => {
  res.json(reversePayment(req.params.id, { reason: req.body?.reason, userId: req.user.id }));
}));
