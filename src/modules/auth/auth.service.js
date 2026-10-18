import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../../db/connection.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, dev default.

export function login(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);

  return { token, user: publicUser(user) };
}

export function logout(token) {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function sessionUser(token) {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS session_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.is_active = 1`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.session_expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return publicUser(row);
}

export function permissionsForUser(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT p.code
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?`
    )
    .all(userId);
  return rows.map((r) => r.code);
}

export function rolesForUser(userId) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`)
    .all(userId);
  return rows.map((r) => r.name);
}

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name };
}
