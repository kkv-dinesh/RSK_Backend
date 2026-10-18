import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.RSK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsk-test-'));
process.env.RSK_DB_PATH = path.join(process.env.RSK_DATA_DIR, 'test.sqlite3');

const { seed } = await import('../src/db/seed/run.js');
const { login, sessionUser, permissionsForUser, logout } = await import('../src/modules/auth/auth.service.js');
const { getDb } = await import('../src/db/connection.js');

test('seed creates roles, permissions, and dev users', () => {
  const result = seed();
  assert.equal(result.roles, 4);
  assert.ok(result.permissions > 0);
  assert.equal(result.users, 2);
});

test('login succeeds with correct dev credentials and fails with wrong password', () => {
  const ok = login('owner', 'owner-dev-only');
  assert.ok(ok?.token);
  assert.equal(ok.user.username, 'owner');

  const bad = login('owner', 'wrong-password');
  assert.equal(bad, null);
});

test('session resolves to the user and expires on logout', () => {
  const { token } = login('staff', 'staff-dev-only');
  assert.ok(sessionUser(token));
  logout(token);
  assert.equal(sessionUser(token), null);
});

test('owner has elevated permissions staff does not', () => {
  const db = getDb();
  const ownerId = db.prepare('SELECT id FROM users WHERE username = ?').get('owner').id;
  const staffId = db.prepare('SELECT id FROM users WHERE username = ?').get('staff').id;
  const ownerPerms = permissionsForUser(ownerId);
  const staffPerms = permissionsForUser(staffId);
  assert.ok(ownerPerms.includes('users.manage'));
  assert.ok(!staffPerms.includes('users.manage'));
});

test('unauthenticated request is never trusted', () => {
  assert.equal(sessionUser(null), null);
  assert.equal(sessionUser('not-a-real-token'), null);
});
