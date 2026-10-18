import { Router } from 'express';
import { createLocation, listLocations } from '../modules/catalog/location.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const locationsRouter = Router();

locationsRouter.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({ data: listLocations() });
}));

locationsRouter.post('/', requireAuth, requirePermission('product.manage'), asyncRoute((req, res) => {
  res.status(201).json(createLocation(req.body ?? {}));
}));
