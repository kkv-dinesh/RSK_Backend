import { Router } from 'express';
import { createCustomer, listCustomers, getCustomer, customerLedger } from '../modules/customers/customer.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const customersRouter = Router();

customersRouter.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listCustomers({ limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0 }) });
}));

customersRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getCustomer(req.params.id));
}));

customersRouter.get('/:id/ledger', requireAuth, asyncRoute((req, res) => {
  res.json(customerLedger(req.params.id));
}));

customersRouter.post('/', requireAuth, asyncRoute((req, res) => {
  res.status(201).json(createCustomer(req.body ?? {}));
}));
