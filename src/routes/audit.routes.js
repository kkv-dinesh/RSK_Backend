import { Router } from 'express';
import { searchAudit, listAuditActions } from '../modules/audit/audit.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const auditRouter = Router();

auditRouter.get('/', requireAuth, requirePermission('audit.view'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { entityType, entityId, action, from, to } = req.query;
  res.json({ ...searchAudit({ entityType, entityId, action, from, to, limit, offset }), limit, offset });
});

auditRouter.get('/actions', requireAuth, requirePermission('audit.view'), (req, res) => {
  res.json({ data: listAuditActions() });
});
