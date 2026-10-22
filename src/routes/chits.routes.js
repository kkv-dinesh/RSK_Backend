import { Router } from 'express';
import {
  createChit, getChit, listChits, recordChitPayment, chitValuation, previewRedemption, redeemChit, previewCancellation, cancelChit,
} from '../modules/chits/chit.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const chitsRouter = Router();

// A hand-typed gold rate bypasses the recorded daily rate, so it needs the same permission as changing rates.
function manualRateGuard(req, res, next) {
  if (req.body?.ratePerGram != null && !req.permissions.has('rate.change')) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing permission: rate.change (needed to override the gold rate).' });
  }
  next();
}

chitsRouter.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listChits({ q: req.query.q, customerId: req.query.customerId, status: req.query.status, limit: Math.min(Number(req.query.limit) || 100, 500), offset: Number(req.query.offset) || 0 }) });
}));

chitsRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getChit(req.params.id));
}));

chitsRouter.get('/:id/valuation', requireAuth, asyncRoute((req, res) => {
  res.json(chitValuation(req.params.id, { date: req.query.date }));
}));

chitsRouter.get('/:id/cancellation-preview', requireAuth, asyncRoute((req, res) => {
  res.json(previewCancellation(req.params.id, { cancellationDate: req.query.date }));
}));

chitsRouter.post('/', requireAuth, requirePermission('chit.create'), asyncRoute((req, res) => {
  res.status(201).json(createChit({ ...req.body, createdBy: req.user.id }));
}));

chitsRouter.post('/:id/payments', requireAuth, requirePermission('chit.pay'), manualRateGuard, asyncRoute((req, res) => {
  const b = req.body ?? {};
  res.status(201).json(recordChitPayment(req.params.id, { paymentDate: b.paymentDate, amount: b.amount, ratePerGram: b.ratePerGram, method: b.method, reference: b.reference, createdBy: req.user.id }));
}));

chitsRouter.post('/:id/redemption-preview', requireAuth, requirePermission('chit.redeem'), manualRateGuard, asyncRoute((req, res) => {
  res.json(previewRedemption(req.params.id, req.body ?? {}));
}));

chitsRouter.post('/:id/redemption', requireAuth, requirePermission('chit.redeem'), manualRateGuard, asyncRoute((req, res) => {
  res.json(redeemChit(req.params.id, { ...(req.body ?? {}), createdBy: req.user.id }));
}));

chitsRouter.post('/:id/cancellation', requireAuth, requirePermission('chit.cancel'), manualRateGuard, asyncRoute((req, res) => {
  res.json(cancelChit(req.params.id, { ...(req.body ?? {}), processedBy: req.user.id }));
}));
