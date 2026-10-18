import { Router } from 'express';
import { recordRate, latestRate, listRateHistory } from '../modules/catalog/rate.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const metalRatesRouter = Router();

metalRatesRouter.get('/', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json({ data: listRateHistory({ metal: req.query.metal, purity: req.query.purity, limit, offset }), limit, offset });
}));

metalRatesRouter.get('/latest', requireAuth, asyncRoute((req, res) => {
  const { metal, purity } = req.query;
  if (!metal || !purity) return res.status(400).json({ error: 'VALIDATION', message: 'metal and purity query params are required.' });
  const rate = latestRate(metal, purity);
  if (!rate) return res.status(404).json({ error: 'NOT_FOUND', message: 'No rate recorded yet for this metal/purity.' });
  res.json(rate);
}));

metalRatesRouter.post('/', requireAuth, requirePermission('rate.change'), asyncRoute((req, res) => {
  const { metal, purity, ratePerGram, effectiveDate, source } = req.body ?? {};
  const rate = recordRate({ metal, purity, ratePerGram, effectiveDate, source, recordedBy: req.user.id });
  res.status(201).json(rate);
}));
