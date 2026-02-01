const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('./db');

const SALT_ROUNDS = 12;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId) {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt]
  );

  return { sessionId, expiresAt };
}

async function validateSession(sessionId) {
  if (!sessionId) return null;

  const result = await pool.query(
    `SELECT s.id as session_id, s.expires_at, u.*
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId]
  );

  return result.rows[0] || null;
}

async function deleteSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

async function cleanExpiredSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
}

async function getAuthMode() {
  const result = await pool.query(`
    SELECT
      (SELECT password_hash FROM users WHERE role = 'admin' LIMIT 1) as admin_password,
      (SELECT COUNT(*) FROM users WHERE role != 'admin') as other_users
  `);

  const row = result.rows[0];
  const adminHasPassword = row?.admin_password != null;
  const hasOtherUsers = parseInt(row?.other_users || '0') > 0;

  if (!adminHasPassword && !hasOtherUsers) {
    return 'single-user';
  }
  return 'multi-user';
}

async function getAdminUser() {
  const result = await pool.query('SELECT * FROM users WHERE role = $1 LIMIT 1', ['admin']);
  return result.rows[0] || null;
}

async function initializeAdmin() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUsername) {
    console.log('ADMIN_USERNAME not set - skipping admin initialization');
    return null;
  }

  // Check if admin already exists
  const existing = await pool.query('SELECT id FROM users WHERE role = $1', ['admin']);
  if (existing.rows.length > 0) {
    console.log('Admin user already exists');
    return existing.rows[0];
  }

  // Create admin user
  const passwordHash = adminPassword ? await hashPassword(adminPassword) : null;
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role, display_name)
     VALUES ($1, $2, 'admin', $1) RETURNING *`,
    [adminUsername, passwordHash]
  );

  console.log(`Admin user '${adminUsername}' created`);
  return result.rows[0];
}

async function migratePatternOwnership() {
  const admin = await getAdminUser();
  if (!admin) return;

  const result = await pool.query(
    'UPDATE patterns SET user_id = $1 WHERE user_id IS NULL',
    [admin.id]
  );

  if (result.rowCount > 0) {
    console.log(`Migrated ${result.rowCount} patterns to admin user`);
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateSessionId,
  createSession,
  validateSession,
  deleteSession,
  cleanExpiredSessions,
  getAuthMode,
  getAdminUser,
  initializeAdmin,
  migratePatternOwnership,
};
