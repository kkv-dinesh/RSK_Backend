import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncRoute } from '../lib/asyncRoute.js';

export const usersRouter = Router();

// Read-only directory of accounts and the role/permission matrix, so the
// Administration screens show what the backend actually enforces.
usersRouter.get('/', requireAuth, requirePermission('users.manage'), asyncRoute((req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, display_name, is_active, created_at FROM users ORDER BY username').all();
  const rolesByUser = db
    .prepare('SELECT ur.user_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.user_id]: [...(acc[r.user_id] || []), r.name] }), {});
  res.json({
    data: users.map((u) => ({
      id: u.id, username: u.username, displayName: u.display_name, active: !!u.is_active,
      roles: rolesByUser[u.id] || [], createdAt: u.created_at,
    })),
  });
}));

usersRouter.get('/roles', requireAuth, requirePermission('users.manage'), asyncRoute((req, res) => {
  const db = getDb();
  const roles = db.prepare('SELECT id, name, description FROM roles ORDER BY id').all();
  const perms = db
    .prepare('SELECT rp.role_id, p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id ORDER BY p.code')
    .all();
  res.json({
    data: roles.map((r) => ({
      name: r.name, description: r.description,
      permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.code),
    })),
    allPermissions: db.prepare('SELECT code FROM permissions ORDER BY code').all().map((p) => p.code),
  });
}));
