import { sessionUser, permissionsForUser, rolesForUser } from '../modules/auth/auth.service.js';

// The browser's claimed role/permissions are never trusted. Every request is
// re-resolved against the session token and the server-side role/permission tables.
export function requireAuth(req, res, next) {
  const token = bearerToken(req);
  const user = sessionUser(token);
  if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Sign in required.' });
  req.user = user;
  req.permissions = new Set(permissionsForUser(user.id));
  req.roles = new Set(rolesForUser(user.id));
  next();
}

export function requirePermission(code) {
  return (req, res, next) => {
    if (!req.permissions?.has(code)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: `Missing permission: ${code}` });
    }
    next();
  };
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}
