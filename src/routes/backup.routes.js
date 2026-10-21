import fs from 'node:fs';
import express, { Router } from 'express';
import { createBackup, restoreBackup } from '../modules/backup/backup.service.js';
import { recordAudit } from '../modules/audit/audit.service.js';
import { getDb } from '../db/connection.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const backupRouter = Router();

// A backup contains every record and every login hash, so it is owner-only.
backupRouter.get('/download', requireAuth, requirePermission('backup.manage'), asyncRoute(async (req, res) => {
  const { file, filename } = await createBackup();
  recordAudit(getDb(), { userId: req.user.id, action: 'BACKUP_DOWNLOAD', entityType: 'system', newState: { filename } });
  res.download(file, filename, () => fs.rm(file, { force: true }, () => {}));
}));

backupRouter.post(
  '/restore',
  requireAuth,
  requirePermission('backup.manage'),
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  asyncRoute(async (req, res) => {
    res.json(await restoreBackup(req.body, { userId: req.user.id }));
  })
);
