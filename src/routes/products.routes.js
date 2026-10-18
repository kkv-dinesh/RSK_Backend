import { Router } from 'express';
import { createProduct, getProduct, listProducts, updateProduct } from '../modules/catalog/product.service.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const productsRouter = Router();

productsRouter.get('/', requireAuth, asyncRoute((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json({ data: listProducts({ category: req.query.category, metal: req.query.metal, limit, offset }), limit, offset });
}));

productsRouter.get('/:id', requireAuth, asyncRoute((req, res) => {
  res.json(getProduct(req.params.id));
}));

productsRouter.post('/', requireAuth, requirePermission('product.manage'), asyncRoute((req, res) => {
  res.status(201).json(createProduct(req.body ?? {}));
}));

productsRouter.patch('/:id', requireAuth, requirePermission('product.manage'), asyncRoute((req, res) => {
  res.json(updateProduct(req.params.id, req.body ?? {}));
}));
