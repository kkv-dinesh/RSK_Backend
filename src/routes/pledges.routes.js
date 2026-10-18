import { Router } from 'express';
import {
  createPledge, getPledge, listPledges, previewInterest, accrueInterest,
  recordPledgePayment, settlePledge, settleInFull,
} from '../modules/pledges/pledge.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const pledgesRouter = Router();

pledgesRouter.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listPledges({ customerId: req.query.customerId, status: req.query.status }) });
}));

pledgesRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getPledge(req.params.id));
}));

pledgesRouter.get('/:id/interest-preview', requireAuth, asyncRoute((req, res) => {
  if (!req.query.asOfDate) return res.status(400).json({ error: 'VALIDATION', message: 'asOfDate query param is required.' });
  res.json(previewInterest(req.params.id, req.query.asOfDate));
}));

pledgesRouter.post('/', requireAuth, requirePermission('pledge.create'), asyncRoute((req, res) => {
  res.status(201).json(createPledge({ ...req.body, createdBy: req.user.id }));
}));

pledgesRouter.post('/:id/accrue-interest', requireAuth, requirePermission('pledge.modify'), asyncRoute((req, res) => {
  res.json(accrueInterest(req.params.id, { asOfDate: req.body?.asOfDate, userId: req.user.id }));
}));

pledgesRouter.post('/:id/payments', requireAuth, requirePermission('pledge.modify'), asyncRoute((req, res) => {
  res.status(201).json(recordPledgePayment(req.params.id, { amount: req.body?.amount, appliedTo: req.body?.appliedTo, userId: req.user.id }));
}));

pledgesRouter.post('/:id/settlement', requireAuth, requirePermission('pledge.settle'), asyncRoute((req, res) => {
  res.json(settlePledge(req.params.id, { reason: req.body?.reason, userId: req.user.id }));
}));

pledgesRouter.post('/:id/settle-in-full', requireAuth, requirePermission('pledge.settle'), asyncRoute((req, res) => {
  res.json(settleInFull(req.params.id, {
    asOfDate: req.body?.asOfDate || new Date().toISOString().slice(0, 10), reason: req.body?.reason, userId: req.user.id,
  }));
}));
