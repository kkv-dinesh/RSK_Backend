import bcrypt from 'bcryptjs';
import { getDb } from '../connection.js';
import { runMigrations } from '../migrate.js';

// DEMO ONLY seed data for local development/testing.
// TODO(OWNER_POLICY): role matrix, permission codes, and default accounts here
// are engineering defaults, not confirmed business policy.
const ROLES = [
  { name: 'OWNER', description: 'Full access including approvals and settings.' },
  { name: 'ADMINISTRATOR', description: 'Operational management, cannot change system settings.' },
  { name: 'SENIOR_STAFF', description: 'Can approve routine requests from staff.' },
  { name: 'STAFF', description: 'Day-to-day data entry, no approval rights.' },
];

const PERMISSIONS = [
  'sale.create', 'sale.cancel',
  'discount.apply', 'discount.approve',
  'rate.change',
  'product.manage',
  'purchase.create', 'purchase.cancel',
  'stock.adjust',
  'order.create', 'order.cancel',
  'payment.create', 'payment.reverse',
  'credit.settle',
  'pledge.create', 'pledge.modify', 'pledge.settle',
  'approval.decide',
  'reports.view', 'profit.view', 'backup.manage',
  'audit.view',
  'users.manage',
];

// Confirmed rule #8: only OWNER/ADMINISTRATOR may perform sensitive actions —
// changing pricing (rate.change), stock adjustments, cancellations/reversals,
// discount approval, pledge settlement, credit settlement, and approval
// decisions. SENIOR_STAFF/STAFF keep only routine day-to-day permissions.
const SENSITIVE_PERMISSIONS = [
  'rate.change', 'stock.adjust',
  'sale.cancel', 'purchase.cancel', 'order.cancel',
  'payment.reverse', 'discount.approve', 'pledge.settle', 'credit.settle',
  'approval.decide', 'users.manage', 'profit.view', 'backup.manage',
];

const ROLE_PERMISSIONS = {
  OWNER: PERMISSIONS,
  ADMINISTRATOR: PERMISSIONS.filter((p) => p !== 'users.manage' && p !== 'backup.manage'),
  SENIOR_STAFF: PERMISSIONS.filter((p) => !SENSITIVE_PERMISSIONS.includes(p)),
  STAFF: ['sale.create', 'purchase.create', 'order.create', 'payment.create', 'pledge.create', 'pledge.modify', 'reports.view'],
};

// DEMO ONLY credentials for local development. Never reuse in production.
// In production (NODE_ENV=production) only the OWNER account is created, and
// its password must come from RSK_OWNER_PASSWORD.
const IS_PROD = process.env.NODE_ENV === 'production';
const DEV_USERS = IS_PROD
  ? [{ username: 'owner', displayName: 'Shop Owner', password: process.env.RSK_OWNER_PASSWORD, role: 'OWNER' }]
  : [
      { username: 'owner', displayName: 'Shop Owner (Demo)', password: 'owner-dev-only', role: 'OWNER' },
      { username: 'staff', displayName: 'Staff User (Demo)', password: 'staff-dev-only', role: 'STAFF' },
    ];

/** Makes sure every role and permission this version knows about exists (safe to repeat; used after a restore too). */
export function syncAccessControl(db = getDb()) {

  const insertRole = db.prepare('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)');
  for (const r of ROLES) insertRole.run(r.name, r.description);

  const insertPermission = db.prepare('INSERT OR IGNORE INTO permissions (code) VALUES (?)');
  for (const p of PERMISSIONS) insertPermission.run(p);

  const roleIdByName = new Map(db.prepare('SELECT id, name FROM roles').all().map((r) => [r.name, r.id]));
  const permIdByCode = new Map(db.prepare('SELECT id, code FROM permissions').all().map((p) => [p.code, p.id]));

  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByName.get(role);
    for (const code of perms) insertRolePerm.run(roleId, permIdByCode.get(code));
  }
}

export function seed(db = getDb()) {
  if (IS_PROD && !process.env.RSK_OWNER_PASSWORD) {
    throw new Error('RSK_OWNER_PASSWORD must be set when seeding in production.');
  }
  runMigrations(db);
  syncAccessControl(db);
  const roleIdByName = new Map(db.prepare('SELECT id, name FROM roles').all().map((r) => [r.name, r.id]));

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, display_name, password_hash) VALUES (?, ?, ?)'
  );
  const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
  for (const u of DEV_USERS) {
    const hash = bcrypt.hashSync(u.password, 10);
    insertUser.run(u.username, u.displayName, hash);
    const userId = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username).id;
    insertUserRole.run(userId, roleIdByName.get(u.role));
  }

  return { roles: ROLES.length, permissions: PERMISSIONS.length, users: DEV_USERS.length };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const result = seed();
  console.log('[seed] applied:', result);
  if (!IS_PROD) console.log('[seed] DEMO ONLY dev logins:', DEV_USERS.map((u) => `${u.username}/${u.password}`).join(', '));
}
