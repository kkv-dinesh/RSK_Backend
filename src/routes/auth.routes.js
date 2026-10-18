import { Router } from 'express';
import { login, logout } from '../modules/auth/auth.service.js';
import { recordAudit } from '../modules/audit/audit.service.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'VALIDATION', message: 'username and password are required.' });
  }
  const result = login(username, password);
  if (!result) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
  }
  recordAudit(undefined, {
    userId: result.user.id,
    action: 'LOGIN',
    entityType: 'user',
    entityId: result.user.id,
  });
  res.json(result);
});

authRouter.post('/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  logout(token);
  recordAudit(undefined, { userId: req.user.id, action: 'LOGOUT', entityType: 'user', entityId: req.user.id });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, permissions: [...req.permissions], roles: [...req.roles] });
});
