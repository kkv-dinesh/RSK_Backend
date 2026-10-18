import { Router } from 'express';
import { listOverdueInvoices, createFollowUp, listFollowUpsForCustomer, recordFollowUpOutcome } from '../modules/credit/credit.service.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const creditRouter = Router();

creditRouter.get('/reminders', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listOverdueInvoices({ overdueDays: req.query.overdueDays ? Number(req.query.overdueDays) : undefined }) });
}));

creditRouter.get('/follow-ups', requireAuth, asyncRoute((req, res) => {
  if (!req.query.customerId) return res.status(400).json({ error: 'VALIDATION', message: 'customerId query param is required.' });
  res.json({ data: listFollowUpsForCustomer(req.query.customerId) });
}));

creditRouter.post('/follow-ups', requireAuth, asyncRoute((req, res) => {
  res.status(201).json(createFollowUp({ ...req.body, createdBy: req.user.id }));
}));

creditRouter.patch('/follow-ups/:id', requireAuth, asyncRoute((req, res) => {
  res.json(recordFollowUpOutcome(req.params.id, req.body ?? {}));
}));
