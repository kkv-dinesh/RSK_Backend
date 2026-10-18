import { Router } from 'express';
import { requestApproval, getApproval, listApprovals, decideApproval } from '../modules/approvals/approval.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const approvalsRouter = Router();

approvalsRouter.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listApprovals({ status: req.query.status }) });
}));

approvalsRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getApproval(req.params.id));
}));

approvalsRouter.post('/', requireAuth, asyncRoute((req, res) => {
  res.status(201).json(requestApproval({ ...req.body, requestedBy: req.user.id }));
}));

approvalsRouter.post('/:id/decision', requireAuth, requirePermission('approval.decide'), asyncRoute((req, res) => {
  res.json(decideApproval(req.params.id, { decision: req.body?.decision, reason: req.body?.reason, decidedBy: req.user.id }));
}));
