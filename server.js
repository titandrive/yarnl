const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { promisify } = require('util');
const { exec } = require('child_process');
const execPromise = promisify(exec);
const sharp = require('sharp');
const pdfParse = require('pdf-parse');
const archiver = require('archiver');
const unzipper = require('unzipper');
const cron = require('node-cron');
const EventEmitter = require('events');
const { pool, initDatabase } = require('./db');
const {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  deleteSession,
  getAuthMode,
  getAdminUser,
  initializeAdmin,
  migratePatternOwnership,
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Server-sent events for real-time notifications
const sseClients = new Set();
const serverEvents = new EventEmitter();

function broadcastEvent(type, data) {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  sseClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

// Middleware
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(cookieParser());

app.use(express.static('public'));
app.use('/mascots', express.static('mascots'));

// Auth middleware - checks session or auto-authenticates in single-user mode
async function authMiddleware(req, res, next) {
  try {
    const authMode = await getAuthMode();

    if (authMode === 'single-user') {
      // Auto-authenticate as admin
      const admin = await getAdminUser();
      if (admin) {
        req.user = admin;
        return next();
      }
      // No admin yet, allow unauthenticated access (first run)
      req.user = null;
      return next();
    }

    // Multi-user mode: require session
    const sessionId = req.cookies.session_id;
    if (!sessionId) {
      return res.status(401).json({ error: 'Authentication required', authRequired: true });
    }

    const session = await validateSession(sessionId);
    if (!session) {
      res.clearCookie('session_id');
      return res.status(401).json({ error: 'Session expired', authRequired: true });
    }

    req.user = session;
    req.sessionId = session.session_id;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// Admin-only middleware
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Pattern permission middleware
function canAddPatterns(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.can_add_patterns) {
    return next();
  }
  return res.status(403).json({ error: 'Permission denied: cannot add patterns' });
}

// SSE endpoint for real-time notifications
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`SSE client connected (${sseClients.size} total)`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`SSE client disconnected (${sseClients.size} remaining)`);
  });
});

// ============================================
// Auth endpoints (public)
// ============================================

// Get auth mode (single-user or multi-user)
app.get('/api/auth/mode', async (req, res) => {
  try {
    const mode = await getAuthMode();
    const admin = await getAdminUser();
    res.json({
      mode,
      hasAdmin: !!admin,
      adminUsername: admin?.username || null
    });
  } catch (error) {
    console.error('Error getting auth mode:', error);
    res.status(500).json({ error: 'Failed to get auth mode' });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({
    id: req.user.id,
    username: req.user.username,
    displayName: req.user.display_name,
    role: req.user.role,
    canAddPatterns: req.user.can_add_patterns
  });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check if local login is disabled (unless FORCE_LOCAL_LOGIN env is set)
    const forceLocalLogin = process.env.FORCE_LOCAL_LOGIN === 'true';
    if (!forceLocalLogin) {
      const oidcSettings = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
      const oidc = oidcSettings.rows[0]?.value;
      if (oidc?.enabled && oidc?.disableLocalLogin) {
        return res.status(403).json({ error: 'Local login is disabled - please use SSO' });
      }
    }

    // If password_required is set but user has no password, they can't login
    if (user.password_required && !user.password_hash) {
      return res.status(401).json({ error: 'Password required - please contact admin to set a password' });
    }

    // If user has password, verify it
    if (user.password_hash) {
      if (!password) {
        return res.status(401).json({ error: 'Password is required' });
      }
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }
    // If no password set and none provided (and not required), allow login

    const { sessionId, expiresAt } = await createSession(user.id);

    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        canAddPatterns: user.can_add_patterns
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    if (req.sessionId) {
      await deleteSession(req.sessionId);
    }
    res.clearCookie('session_id');
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ============================================
// User settings sync (per-user preferences)
// ============================================

app.get('/api/user/settings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT client_settings FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]?.client_settings || {});
  } catch (error) {
    console.error('Error fetching user settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/user/settings', authMiddleware, async (req, res) => {
  try {
    const settings = req.body;
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'Settings must be a JSON object' });
    }
    const json = JSON.stringify(settings);
    if (json.length > 50000) {
      return res.status(400).json({ error: 'Settings too large' });
    }
    await pool.query(
      'UPDATE users SET client_settings = $1, updated_at = NOW() WHERE id = $2',
      [json, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving user settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ============================================
// User management endpoints (admin only)
// ============================================

// List all users
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, display_name, role, can_add_patterns, password_required, oidc_allowed, oidc_provider,
              can_change_username, can_change_password, created_at, last_login,
              (password_hash IS NOT NULL) as has_password
       FROM users ORDER BY created_at`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Create user
app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username, password, role, canAddPatterns, passwordRequired, oidcAllowed, canChangeUsername, canChangePassword } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Check if username already exists
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const passwordHash = password ? await hashPassword(password) : null;

    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, can_add_patterns, password_required, oidc_allowed, can_change_username, can_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, username, role, can_add_patterns, created_at`,
      [
        username,
        passwordHash,
        role || 'user',
        canAddPatterns !== false,
        passwordRequired === true,
        oidcAllowed !== false,
        canChangeUsername !== false,
        canChangePassword !== false
      ]
    );

    const newUser = result.rows[0];

    // Create default categories for the new user
    await createDefaultCategoriesForUser(newUser.id);

    // Create user directories
    await ensureUserDirectories(username);

    res.json(newUser);
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user
app.patch('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role, canAddPatterns, password, displayName, passwordRequired, oidcAllowed, username, removePassword } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (username !== undefined) {
      // Check if username is already taken
      const existing = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, userId]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      updates.push(`username = $${paramCount++}`);
      values.push(username);
    }
    if (role !== undefined) {
      updates.push(`role = $${paramCount++}`);
      values.push(role);
    }
    if (canAddPatterns !== undefined) {
      updates.push(`can_add_patterns = $${paramCount++}`);
      values.push(canAddPatterns);
    }
    if (displayName !== undefined) {
      updates.push(`display_name = $${paramCount++}`);
      values.push(displayName);
    }
    if (removePassword) {
      updates.push(`password_hash = $${paramCount++}`);
      values.push(null);
    } else if (password !== undefined) {
      const hash = password ? await hashPassword(password) : null;
      updates.push(`password_hash = $${paramCount++}`);
      values.push(hash);
    }
    if (passwordRequired !== undefined) {
      updates.push(`password_required = $${paramCount++}`);
      values.push(passwordRequired);
    }
    if (oidcAllowed !== undefined) {
      updates.push(`oidc_allowed = $${paramCount++}`);
      values.push(oidcAllowed);
    }
    if (req.body.canChangeUsername !== undefined) {
      updates.push(`can_change_username = $${paramCount++}`);
      values.push(req.body.canChangeUsername);
    }
    if (req.body.canChangePassword !== undefined) {
      updates.push(`can_change_password = $${paramCount++}`);
      values.push(req.body.canChangePassword);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount}
       RETURNING id, username, display_name, role, can_add_patterns, password_required, oidc_allowed`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user
app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Prevent deleting self
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    // Check if user exists and get username
    const user = await pool.query('SELECT role, username FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const username = user.rows[0].username;

    // Move user's data to _deleted folder before deleting from database
    await deleteUserData(username);

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Remove user password (admin only, requires admin password verification)
app.post('/api/users/:id/remove-password', authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { adminPassword } = req.body;

    if (!adminPassword) {
      return res.status(400).json({ error: 'Admin password required' });
    }

    // Verify admin's password
    const adminUser = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!adminUser.rows[0]?.password_hash) {
      return res.status(400).json({ error: 'Admin has no password set' });
    }

    const validPassword = await verifyPassword(adminPassword, adminUser.rows[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid admin password' });
    }

    // Remove the user's password
    await pool.query('UPDATE users SET password_hash = NULL, updated_at = NOW() WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing password:', error);
    res.status(500).json({ error: 'Failed to remove password' });
  }
});

// Get default categories for new users (admin only)
app.get('/api/admin/default-categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const categories = await getDefaultCategories();
    res.json(categories);
  } catch (error) {
    console.error('Error getting default categories:', error);
    res.status(500).json({ error: 'Failed to get default categories' });
  }
});

// Save default categories for new users (admin only)
app.post('/api/admin/default-categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { categories } = req.body;
    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: 'Categories must be an array' });
    }

    // Filter out empty strings and duplicates
    const cleanCategories = [...new Set(categories.filter(c => c && c.trim()))].map(c => c.trim());

    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('default_categories', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(cleanCategories)]
    );

    res.json({ success: true, categories: cleanCategories });
  } catch (error) {
    console.error('Error saving default categories:', error);
    res.status(500).json({ error: 'Failed to save default categories' });
  }
});

// User removes their own password (requires current password verification)
app.post('/api/auth/remove-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword } = req.body;

    // Check if user has password_required set
    const user = await pool.query('SELECT password_hash, password_required FROM users WHERE id = $1', [req.user.id]);
    if (user.rows[0]?.password_required) {
      return res.status(403).json({ error: 'Password removal not allowed - admin requires you to have a password' });
    }

    // Verify current password
    if (!user.rows[0]?.password_hash) {
      return res.status(400).json({ error: 'You don\'t have a password set' });
    }

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password required' });
    }

    const validPassword = await verifyPassword(currentPassword, user.rows[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Remove password
    await pool.query('UPDATE users SET password_hash = NULL, updated_at = NOW() WHERE id = $1', [req.user.id]);
    res.json({ success: true, message: 'Password removed - you can now login without a password' });
  } catch (error) {
    console.error('Error removing own password:', error);
    res.status(500).json({ error: 'Failed to remove password' });
  }
});

// Get current user's account info
app.get('/api/auth/account', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, role, can_add_patterns, password_required, oidc_allowed, oidc_provider,
              can_change_username, can_change_password,
              (password_hash IS NOT NULL) as has_password
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = result.rows[0];
    res.json({
      ...user,
      allow_username_change: user.can_change_username !== false,
      allow_password_change: user.can_change_password !== false
    });
  } catch (error) {
    console.error('Error getting account info:', error);
    res.status(500).json({ error: 'Failed to get account info' });
  }
});

// Update current user's account info (username)
app.patch('/api/auth/account', authMiddleware, async (req, res) => {
  try {
    const { username } = req.body;
    const oldUsername = req.user.username;

    if (!username || username.trim().length === 0) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const newUsername = username.trim();

    // Check if username changes are allowed for this user
    const userResult = await pool.query('SELECT can_change_username FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows[0]?.can_change_username === false) {
      return res.status(403).json({ error: 'Username changes are not allowed for your account' });
    }

    // Check if username is actually changing
    if (newUsername === oldUsername) {
      return res.json({ success: true });
    }

    // Check if username is already taken
    const existing = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [newUsername, req.user.id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    // Rename user directories before updating database
    await renameUserDirectories(oldUsername, newUsername);

    await pool.query(
      'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2',
      [newUsername, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating account info:', error);
    res.status(500).json({ error: 'Failed to update account info' });
  }
});

// Change password
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Check if password changes are allowed for this user
    const userCheck = await pool.query('SELECT can_change_password, password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = userCheck.rows[0];

    if (user?.can_change_password === false) {
      return res.status(403).json({ error: 'Password changes are not allowed for your account' });
    }

    if (!newPassword || newPassword.length < 1) {
      return res.status(400).json({ error: 'New password is required' });
    }

    // If user has a password, verify current password
    if (user?.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' });
      }
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    // Hash and save new password
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ============================================
// OIDC endpoints
// ============================================

// Get OIDC settings (admin only)
app.get('/api/auth/oidc/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const settings = result.rows[0]?.value || {
      enabled: false,
      issuer: '',
      clientId: '',
      clientSecret: '',
      disableLocalLogin: false,
      autoCreateUsers: true,
      defaultRole: 'user'
    };
    // Don't expose client secret
    res.json({ ...settings, clientSecret: settings.clientSecret ? '********' : '' });
  } catch (error) {
    console.error('Error getting OIDC settings:', error);
    res.status(500).json({ error: 'Failed to get OIDC settings' });
  }
});

// Save OIDC settings (admin only)
app.post('/api/auth/oidc/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    console.log('OIDC settings save request:', JSON.stringify(req.body));
    const { enabled, issuer, clientId, clientSecret, disableLocalLogin, autoCreateUsers, defaultRole, providerName, iconUrl } = req.body;

    // Get existing settings to preserve client secret if not changed
    const existing = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const existingSettings = existing.rows[0]?.value || {};

    const settings = {
      enabled: enabled === true,
      issuer: issuer || '',
      clientId: clientId || '',
      clientSecret: clientSecret === '********' ? existingSettings.clientSecret : (clientSecret || ''),
      disableLocalLogin: disableLocalLogin === true,
      autoCreateUsers: autoCreateUsers !== false,
      defaultRole: defaultRole || 'user',
      providerName: providerName || existingSettings.providerName || '',
      iconUrl: iconUrl || existingSettings.iconUrl || ''
    };

    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('oidc', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(settings)]
    );

    console.log('OIDC settings saved successfully:', JSON.stringify(settings));
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving OIDC settings:', error);
    res.status(500).json({ error: 'Failed to save OIDC settings' });
  }
});

// Reset OIDC configuration (admin only)
app.post('/api/auth/oidc/reset', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Delete OIDC settings
    await pool.query("DELETE FROM settings WHERE key = 'oidc'");

    // Unlink all OIDC-linked users
    await pool.query(
      "UPDATE users SET oidc_subject = NULL, oidc_provider = NULL, updated_at = NOW() WHERE oidc_subject IS NOT NULL"
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting OIDC:', error);
    res.status(500).json({ error: 'Failed to reset OIDC settings' });
  }
});

// Toggle OIDC enabled/disabled (admin only)
app.post('/api/auth/oidc/toggle', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { enabled } = req.body;

    // Get existing settings and just update enabled
    const existing = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const existingSettings = existing.rows[0]?.value || {};

    const settings = {
      ...existingSettings,
      enabled: enabled === true
    };

    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('oidc', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(settings)]
    );

    console.log('OIDC toggled:', enabled);
    res.json({ success: true });
  } catch (error) {
    console.error('Error toggling OIDC:', error);
    res.status(500).json({ error: 'Failed to toggle OIDC' });
  }
});

// OIDC issuer discovery
app.post('/api/auth/oidc/discover', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { issuer: issuerUrl } = req.body;

    if (!issuerUrl) {
      return res.status(400).json({ error: 'Issuer URL is required' });
    }

    const { Issuer } = require('openid-client');
    const discovered = await Issuer.discover(issuerUrl);

    // Store discovery info
    const existing = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const existingSettings = existing.rows[0]?.value || {};

    const settings = {
      ...existingSettings,
      issuer: discovered.issuer,
      providerName: existingSettings.providerName ||
                    discovered.metadata?.service_documentation?.split('/')[2] ||
                    new URL(discovered.issuer).hostname.split('.')[0] ||
                    'SSO',
      discoveredAt: new Date().toISOString()
    };

    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('oidc', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(settings)]
    );

    res.json({
      issuer: discovered.issuer,
      issuer_name: settings.providerName,
      authorization_endpoint: discovered.authorization_endpoint,
      token_endpoint: discovered.token_endpoint,
      userinfo_endpoint: discovered.userinfo_endpoint,
      jwks_uri: discovered.jwks_uri,
      end_session_endpoint: discovered.end_session_endpoint,
      scopes_supported: discovered.scopes_supported
    });
  } catch (error) {
    console.error('OIDC discovery error:', error);
    res.status(400).json({ error: 'Failed to discover issuer - check the URL' });
  }
});

// OIDC login initiation
app.get('/api/auth/oidc/login', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const settings = result.rows[0]?.value;

    if (!settings?.enabled || !settings?.issuer || !settings?.clientId) {
      return res.status(400).json({ error: 'OIDC not configured' });
    }

    const { Issuer, generators } = require('openid-client');

    // Auto-generate redirect URI from request
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectUri = `${protocol}://${host}/api/auth/oidc/callback`;

    const issuer = await Issuer.discover(settings.issuer);
    const client = new issuer.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code']
    });

    const state = generators.state();
    const nonce = generators.nonce();

    // Store state, nonce, and redirect URI in cookies
    res.cookie('oidc_state', state, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });
    res.cookie('oidc_nonce', nonce, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });
    res.cookie('oidc_redirect', redirectUri, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });

    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state,
      nonce
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error('OIDC login error:', error);
    res.redirect('/#login-error');
  }
});

// OIDC callback - handles both login and account linking
app.get('/api/auth/oidc/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const storedState = req.cookies.oidc_state;
    const storedNonce = req.cookies.oidc_nonce;
    const storedRedirect = req.cookies.oidc_redirect;
    const linkUserId = req.cookies.oidc_link_user; // Present if this is a link operation

    if (state !== storedState) {
      return res.status(400).send('State mismatch - possible CSRF attack');
    }

    const result = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const settings = result.rows[0]?.value;

    if (!settings?.enabled) {
      return res.status(400).send('OIDC not enabled');
    }

    const { Issuer } = require('openid-client');

    // Use stored redirect URI from cookie
    const redirectUri = storedRedirect || `${req.protocol}://${req.get('host')}/api/auth/oidc/callback`;

    const issuer = await Issuer.discover(settings.issuer);
    const client = new issuer.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code']
    });

    const tokenSet = await client.callback(redirectUri, req.query, { state: storedState, nonce: storedNonce });
    const claims = tokenSet.claims();

    // Clear OIDC cookies
    res.clearCookie('oidc_state');
    res.clearCookie('oidc_nonce');
    res.clearCookie('oidc_redirect');
    res.clearCookie('oidc_link_user');

    // Check if this is a link operation
    if (linkUserId) {
      // Check if this OIDC subject is already linked to another user
      const existingUser = await pool.query('SELECT id FROM users WHERE oidc_subject = $1', [claims.sub]);
      if (existingUser.rows.length > 0 && existingUser.rows[0].id !== parseInt(linkUserId)) {
        return res.redirect('/#settings?error=oidc-already-used');
      }

      // Link the OIDC account to the user
      await pool.query(
        `UPDATE users SET oidc_subject = $1, oidc_provider = $2, updated_at = NOW() WHERE id = $3`,
        [claims.sub, settings.providerName || new URL(settings.issuer).hostname, parseInt(linkUserId)]
      );

      return res.redirect('/#settings?success=oidc-linked');
    }

    // Regular login flow - find or create user
    let user = await pool.query('SELECT * FROM users WHERE oidc_subject = $1', [claims.sub]);

    if (user.rows.length === 0) {
      if (!settings.autoCreateUsers) {
        return res.status(403).send('User not found and auto-creation is disabled');
      }

      // Create new user from OIDC claims
      const username = claims.preferred_username || claims.email || claims.sub;
      const displayName = claims.name || username;

      user = await pool.query(
        `INSERT INTO users (username, display_name, role, oidc_subject, oidc_provider)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [username, displayName, settings.defaultRole || 'user', claims.sub, settings.providerName || 'oidc']
      );

      // Create default categories for new OIDC user
      await createDefaultCategoriesForUser(user.rows[0].id);
    }

    const userData = user.rows[0];

    // Create session
    const { sessionId, expiresAt } = await createSession(userData.id);

    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [userData.id]);

    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt
    });

    res.redirect('/#current');
  } catch (error) {
    console.error('OIDC callback error:', error);
    res.redirect('/#login-error');
  }
});

// Check if OIDC is enabled (public)
app.get('/api/auth/oidc/enabled', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const settings = result.rows[0]?.value;
    const forceLocalLogin = process.env.FORCE_LOCAL_LOGIN === 'true';
    res.json({
      enabled: settings?.enabled === true,
      disableLocalLogin: settings?.disableLocalLogin === true && !forceLocalLogin,
      providerName: settings?.providerName || 'SSO',
      iconUrl: settings?.iconUrl || ''
    });
  } catch (error) {
    res.json({ enabled: false, disableLocalLogin: false, providerName: 'SSO', iconUrl: '' });
  }
});

// OIDC account linking - initiate linking for logged-in user
app.get('/api/auth/oidc/link', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");
    const settings = result.rows[0]?.value;

    if (!settings?.enabled || !settings?.issuer || !settings?.clientId) {
      return res.status(400).json({ error: 'OIDC not configured' });
    }

    // Check if user is allowed to use OIDC
    const user = await pool.query('SELECT oidc_subject, oidc_allowed FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0]?.oidc_allowed) {
      return res.redirect('/#settings?error=oidc-not-allowed');
    }
    if (user.rows[0]?.oidc_subject) {
      return res.redirect('/#settings?error=already-linked');
    }

    const { Issuer, generators } = require('openid-client');

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    // Use the same callback URL as regular login
    const redirectUri = `${protocol}://${host}/api/auth/oidc/callback`;

    const issuer = await Issuer.discover(settings.issuer);
    const client = new issuer.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code']
    });

    const state = generators.state();
    const nonce = generators.nonce();

    // Store state, nonce, redirect URI, and user ID being linked
    res.cookie('oidc_state', state, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });
    res.cookie('oidc_nonce', nonce, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });
    res.cookie('oidc_redirect', redirectUri, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });
    res.cookie('oidc_link_user', req.user.id.toString(), { httpOnly: true, maxAge: 300000, sameSite: 'lax' });

    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state,
      nonce
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error('OIDC link error:', error);
    res.redirect('/#settings?error=link-failed');
  }
});

// Unlink OIDC account
app.post('/api/auth/oidc/unlink', authMiddleware, async (req, res) => {
  try {
    // Check if user has a password or would be locked out
    const user = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0]?.password_hash) {
      return res.status(400).json({ error: 'Cannot unlink - you need a password set first to login without SSO' });
    }

    await pool.query(
      'UPDATE users SET oidc_subject = NULL, oidc_provider = NULL, updated_at = NOW() WHERE id = $1',
      [req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error unlinking OIDC:', error);
    res.status(500).json({ error: 'Failed to unlink SSO account' });
  }
});

// ============================================

// Apply auth middleware to all protected API routes
app.use('/api', (req, res, next) => {
  // Skip auth for public endpoints
  const publicPaths = ['/auth/mode', '/auth/login', '/auth/oidc/login', '/auth/oidc/callback', '/events'];
  const isPublic = publicPaths.some(p => req.path === p || req.path.startsWith(p));
  if (isPublic) {
    return next();
  }
  // Apply auth middleware to everything else
  return authMiddleware(req, res, next);
});

// Base directory for all user data
const usersDir = path.join(__dirname, 'users');

// Ensure base directory exists
if (!fs.existsSync(usersDir)) {
  fs.mkdirSync(usersDir, { recursive: true });
}

// User-specific directory helpers - all under users/[username]/
function getUserBaseDir(username) {
  return path.join(usersDir, username);
}

function getUserPatternsDir(username) {
  return path.join(usersDir, username, 'patterns');
}

function getUserThumbnailsDir(username) {
  return path.join(usersDir, username, 'thumbnails');
}

function getUserImagesDir(username) {
  return path.join(usersDir, username, 'images');
}

function getUserArchiveDir(username) {
  return path.join(usersDir, username, 'archive');
}

function getUserArchiveThumbnailsDir(username) {
  return path.join(usersDir, username, 'archive', 'thumbnails');
}

function getUserNotesDir(username) {
  return path.join(usersDir, username, 'notes');
}

function getUserBackupsDir(username) {
  return path.join(usersDir, username, 'backups');
}

// Ensure all directories exist for a user
async function ensureUserDirectories(username) {
  const dirs = [
    getUserPatternsDir(username),
    getUserThumbnailsDir(username),
    getUserImagesDir(username),
    getUserArchiveDir(username),
    getUserArchiveThumbnailsDir(username),
    getUserNotesDir(username),
    getUserBackupsDir(username)
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Rename user directories when username changes
async function renameUserDirectories(oldUsername, newUsername) {
  const oldPath = getUserBaseDir(oldUsername);
  const newPath = getUserBaseDir(newUsername);

  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  }
}

// Permanently delete user data when user is deleted
async function deleteUserData(username) {
  const userDir = getUserBaseDir(username);

  if (fs.existsSync(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

// Fallback default categories for new users (used if admin hasn't configured any)
const FALLBACK_DEFAULT_CATEGORIES = ['Amigurumi', 'Wearables', 'Tunisian', 'Lace', 'Colorwork', 'Freeform', 'Micro', 'Other'];

// Get default categories from settings or use fallback
async function getDefaultCategories() {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'default_categories'");
    const saved = result.rows[0]?.value;
    if (saved && Array.isArray(saved) && saved.length > 0) {
      return saved;
    }
  } catch (error) {
    console.error('Error loading default categories:', error);
  }
  return FALLBACK_DEFAULT_CATEGORIES;
}

// Create default categories for a new user
async function createDefaultCategoriesForUser(userId) {
  const categories = await getDefaultCategories();
  for (let i = 0; i < categories.length; i++) {
    await pool.query(
      'INSERT INTO categories (name, user_id, position) VALUES ($1, $2, $3) ON CONFLICT (user_id, name) DO NOTHING',
      [categories[i], userId, i]
    );
  }
}

// Helper function to format local timestamp for filenames
function getLocalTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

// Convert category name to folder name (lowercase, spaces to underscores, sanitized)
function categoryToFolderName(categoryName) {
  return categoryName
    .toLowerCase()
    .replace(/\s+/g, '_')           // spaces to underscores
    .replace(/[^a-z0-9_-]/g, '')    // remove unsafe characters
    .replace(/_+/g, '_')            // collapse multiple underscores
    .replace(/^_|_$/g, '');         // trim leading/trailing underscores
}

// Helper function to get category folder path (now requires username)
function getCategoryDir(username, categoryName) {
  return path.join(getUserPatternsDir(username), categoryToFolderName(categoryName));
}

// Helper function to ensure category folder exists
function ensureCategoryDir(username, categoryName) {
  const categoryDir = getCategoryDir(username, categoryName);
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }
  return categoryDir;
}

// Helper function to remove category folder (only if empty)
function removeCategoryDir(username, categoryName) {
  const categoryDir = getCategoryDir(username, categoryName);
  if (fs.existsSync(categoryDir)) {
    try {
      fs.rmdirSync(categoryDir);
    } catch (err) {
      // Folder not empty or other error - ignore
      console.log(`Could not remove category folder: ${categoryDir}`);
    }
  }
}

// Helper function to rename category folder
function renameCategoryDir(username, oldName, newName) {
  const oldDir = getCategoryDir(username, oldName);
  const newDir = getCategoryDir(username, newName);
  if (fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, newDir);
  } else {
    // Old folder doesn't exist, just create the new one
    ensureCategoryDir(username, newName);
  }
}

// Helper function to get archive category folder path (now requires username)
function getArchiveCategoryDir(username, categoryName) {
  return path.join(getUserArchiveDir(username), categoryToFolderName(categoryName));
}

// Helper function to ensure archive category folder exists
function ensureArchiveCategoryDir(username, categoryName) {
  const categoryDir = getArchiveCategoryDir(username, categoryName);
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }
  return categoryDir;
}

// Helper function to clean up empty archive category directories (per-user)
function cleanupEmptyArchiveCategories() {
  try {
    // Iterate through user directories in users/
    const userDirs = fs.readdirSync(usersDir, { withFileTypes: true });
    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      if (userDir.name.startsWith('.')) continue;

      const userArchivePath = getUserArchiveDir(userDir.name);
      if (!fs.existsSync(userArchivePath)) continue;

      const entries = fs.readdirSync(userArchivePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'thumbnails') continue;
        const categoryPath = path.join(userArchivePath, entry.name);
        try {
          const files = fs.readdirSync(categoryPath);
          if (files.length === 0) {
            fs.rmdirSync(categoryPath);
          }
        } catch (err) {
          // Ignore errors reading category directory
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up empty archive categories:', error);
  }
}

// Note: Category folders are now per-user and created on-demand when patterns are uploaded
// This function is kept for backward compatibility but is now a no-op
async function syncCategoryFolders() {
  console.log('Category folders are now per-user - created on-demand');
}

// Helper function to sanitize filename
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Helper function to find unique filename
function getUniqueFilename(directory, baseName, extension) {
  let filename = `${baseName}${extension}`;
  let counter = 2;

  while (fs.existsSync(path.join(directory, filename))) {
    filename = `${baseName}_${counter}${extension}`;
    counter++;
  }

  return filename;
}

// Helper function to clean up empty category directories
async function cleanupEmptyCategories() {
  try {
    // Iterate through user directories in users/
    const userDirs = fs.readdirSync(usersDir, { withFileTypes: true });

    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      if (userDir.name.startsWith('.')) continue;

      const userPatternsPath = getUserPatternsDir(userDir.name);
      if (!fs.existsSync(userPatternsPath)) continue;

      const entries = fs.readdirSync(userPatternsPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const categoryPath = path.join(userPatternsPath, entry.name);
        try {
          const files = fs.readdirSync(categoryPath);

          // If directory is empty, remove it
          if (files.length === 0) {
            fs.rmdirSync(categoryPath);
            console.log(`Removed empty category directory: ${userDir.name}/${entry.name}`);
          }
        } catch (err) {
          // Ignore errors reading category directory
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up empty categories:', error);
  }
}

// Configure multer for PDF uploads
// Note: req.body is NOT available in these callbacks, so we use temp filenames
const uploadTempDir = path.join(__dirname, 'temp-uploads');
if (!fs.existsSync(uploadTempDir)) {
  fs.mkdirSync(uploadTempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Use a temp directory - we'll move to user's category folder after upload
    cb(null, uploadTempDir);
  },
  filename: (req, file, cb) => {
    // Use temp filename - we'll rename based on req.body.name after upload completes
    const tempFilename = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${file.originalname}`;
    cb(null, tempFilename);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Separate upload handler for images (thumbnails)
const imageUpload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for images
  }
});

// Helper function to get pattern with owner's username
async function getPatternWithOwner(patternId) {
  const result = await pool.query(`
    SELECT p.*, u.username as owner_username
    FROM patterns p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = $1
  `, [patternId]);
  return result.rows[0];
}

// Helper function to verify pattern ownership for modifications (returns pattern with owner or null if not authorized)
async function verifyPatternOwnership(patternId, currentUserId, isAdmin = false) {
  const pattern = await getPatternWithOwner(patternId);
  if (!pattern) return null;

  // Admins can access any pattern, or user owns the pattern
  if (isAdmin || pattern.user_id === currentUserId) {
    return pattern;
  }
  return null;
}

// Helper function to verify pattern read access (allows owner, admin, or public patterns)
async function verifyPatternReadAccess(patternId, currentUserId, isAdmin = false) {
  const pattern = await getPatternWithOwner(patternId);
  if (!pattern) return null;

  // Admins can access any pattern
  if (isAdmin) return pattern;

  // Owner can access their own pattern
  if (pattern.user_id === currentUserId) return pattern;

  // Anyone can access public patterns
  if (pattern.visibility === 'public') return pattern;

  // Legacy patterns with no user_id are accessible
  if (pattern.user_id === null) return pattern;

  return null;
}

// Helper function to verify counter ownership through its associated pattern
async function verifyCounterOwnership(counterId, currentUserId, isAdmin = false) {
  // Get counter and its associated pattern
  const counterResult = await pool.query(
    'SELECT c.*, p.user_id as pattern_user_id FROM counters c JOIN patterns p ON c.pattern_id = p.id WHERE c.id = $1',
    [counterId]
  );
  if (counterResult.rows.length === 0) return null;

  const counter = counterResult.rows[0];

  // Admins can access any counter, or user owns the pattern
  if (isAdmin || counter.pattern_user_id === currentUserId) {
    return counter;
  }
  return null;
}

// Helper function to get project with owner's username
async function getProjectWithOwner(projectId) {
  const result = await pool.query(`
    SELECT p.*, u.username as owner_username
    FROM projects p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = $1
  `, [projectId]);
  return result.rows[0];
}

// Helper function to verify project ownership for modifications
async function verifyProjectOwnership(projectId, currentUserId, isAdmin = false) {
  const project = await getProjectWithOwner(projectId);
  if (!project) return null;

  // Admins can access any project, or user owns the project
  if (isAdmin || project.user_id === currentUserId) {
    return project;
  }
  return null;
}

// Helper function to verify project read access
async function verifyProjectReadAccess(projectId, currentUserId, isAdmin = false) {
  const project = await getProjectWithOwner(projectId);
  if (!project) return null;

  // Admins can access any project
  if (isAdmin) return project;

  // Owner can access their own project
  if (project.user_id === currentUserId) return project;

  return null;
}

// Helper function to get user's project notes directory
function getUserProjectNotesDir(username) {
  // Project notes go in the same notes/ folder as pattern notes, with "project-" prefix
  return path.join(usersDir, username, 'notes');
}

// Helper function to generate thumbnail from PDF (now requires username for path)
async function generateThumbnail(pdfPath, outputFilename, username) {
  try {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `temp-${Date.now()}.png`);

    // Use pdftocairo to convert first page to PNG
    await execPromise(`pdftocairo -png -f 1 -l 1 -singlefile "${pdfPath}" "${tempFile.replace('.png', '')}"`);

    if (!fs.existsSync(tempFile)) {
      console.error('Temp file not created');
      return null;
    }

    // Resize to thumbnail size - use user's thumbnail directory
    const userThumbnailsDir = getUserThumbnailsDir(username);
    if (!fs.existsSync(userThumbnailsDir)) {
      fs.mkdirSync(userThumbnailsDir, { recursive: true });
    }
    const thumbnailPath = path.join(userThumbnailsDir, outputFilename);
    await sharp(tempFile)
      .resize(300, 400, {
        fit: 'cover',
        position: 'top'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);

    // Clean up temp file
    fs.unlinkSync(tempFile);

    return outputFilename;
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    return null;
  }
}

// Migrate categories to per-user: create default categories for users who don't have any
async function migrateCategoriesToPerUser() {
  try {
    // Get all users
    const usersResult = await pool.query('SELECT id, username FROM users');

    for (const user of usersResult.rows) {
      // Check if user has any categories
      const catCount = await pool.query(
        'SELECT COUNT(*) FROM categories WHERE user_id = $1',
        [user.id]
      );

      if (parseInt(catCount.rows[0].count) === 0) {
        console.log(`Creating default categories for user: ${user.username}`);
        await createDefaultCategoriesForUser(user.id);
      }

      // Ensure user directories exist
      await ensureUserDirectories(user.username);
    }

    console.log('Category migration complete');
  } catch (error) {
    console.error('Error migrating categories:', error);
  }
}

// Migrate existing data from flat directories to admin user's directory
async function migrateExistingDataToAdmin() {
  try {
    // Check if migration already done
    const migrated = await pool.query("SELECT value FROM settings WHERE key = 'data_migrated_to_users'");
    if (migrated.rows.length > 0) {
      console.log('Data migration already complete');
      return;
    }

    // Get admin user
    const adminResult = await pool.query("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1");
    if (adminResult.rows.length === 0) {
      console.log('No admin user found, skipping data migration');
      return;
    }

    const admin = adminResult.rows[0];
    console.log(`Migrating existing data to admin user: ${admin.username}`);

    // Ensure admin directories exist
    await ensureUserDirectories(admin.username);

    // OLD directory paths (before the users/ restructure)
    const oldPatternsDir = path.join(__dirname, 'patterns');
    const oldArchiveDir = path.join(__dirname, 'archive');
    const oldNotesDir = path.join(__dirname, 'notes');
    const oldBackupsDir = path.join(__dirname, 'backups');

    // Helper to move directory contents
    const moveContents = (src, dest) => {
      if (!fs.existsSync(src)) return;
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }

      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        // Skip if already moved (user folders)
        if (fs.existsSync(destPath)) continue;

        // Skip the admin's own folder to avoid recursion
        if (srcPath === dest) continue;

        if (entry.isDirectory()) {
          // Skip user directories (folders that match usernames)
          const isUserDir = fs.existsSync(path.join(srcPath, 'thumbnails')) ||
                           fs.existsSync(path.join(srcPath, 'images'));
          if (!isUserDir) {
            // This is a category folder, move it
            fs.renameSync(srcPath, destPath);
            console.log(`Moved category: ${entry.name}`);
          }
        } else {
          // Move files
          fs.renameSync(srcPath, destPath);
          console.log(`Moved file: ${entry.name}`);
        }
      }
    };

    // Move patterns (categories, thumbnails, images) from old structure
    const oldThumbnailsDir = path.join(oldPatternsDir, 'thumbnails');
    const oldImagesDir = path.join(oldPatternsDir, 'images');

    if (fs.existsSync(oldThumbnailsDir)) {
      moveContents(oldThumbnailsDir, getUserThumbnailsDir(admin.username));
      fs.rmSync(oldThumbnailsDir, { recursive: true, force: true });
      console.log('Moved thumbnails to admin');
    }

    if (fs.existsSync(oldImagesDir)) {
      moveContents(oldImagesDir, getUserImagesDir(admin.username));
      fs.rmSync(oldImagesDir, { recursive: true, force: true });
      console.log('Moved images to admin');
    }

    // Move category folders to admin
    if (fs.existsSync(oldPatternsDir)) {
      const patternEntries = fs.readdirSync(oldPatternsDir, { withFileTypes: true });
      for (const entry of patternEntries) {
        if (entry.isDirectory() && entry.name !== admin.username) {
          const srcPath = path.join(oldPatternsDir, entry.name);
          const destPath = path.join(getUserPatternsDir(admin.username), entry.name);

          // Check if it's a category folder (not a user folder)
          const hasPatternFiles = fs.readdirSync(srcPath).some(f => f.endsWith('.pdf') || f.endsWith('.md'));
          if (hasPatternFiles) {
            fs.renameSync(srcPath, destPath);
            console.log(`Moved category folder: ${entry.name}`);
          }
        }
      }
    }

    // Move archive folders
    if (fs.existsSync(oldArchiveDir)) {
      const oldArchiveThumbnails = path.join(oldArchiveDir, 'thumbnails');
      if (fs.existsSync(oldArchiveThumbnails)) {
        moveContents(oldArchiveThumbnails, getUserArchiveThumbnailsDir(admin.username));
        fs.rmSync(oldArchiveThumbnails, { recursive: true, force: true });
      }

      const archiveEntries = fs.readdirSync(oldArchiveDir, { withFileTypes: true });
      for (const entry of archiveEntries) {
        if (entry.isDirectory() && entry.name !== admin.username) {
          const srcPath = path.join(oldArchiveDir, entry.name);
          const destPath = path.join(getUserArchiveDir(admin.username), entry.name);

          const hasFiles = fs.readdirSync(srcPath).length > 0;
          if (hasFiles) {
            fs.renameSync(srcPath, destPath);
            console.log(`Moved archive folder: ${entry.name}`);
          }
        }
      }
    }

    // Move notes
    if (fs.existsSync(oldNotesDir)) {
      const noteFiles = fs.readdirSync(oldNotesDir).filter(f => f.endsWith('.md'));
      for (const file of noteFiles) {
        const srcPath = path.join(oldNotesDir, file);
        const destPath = path.join(getUserNotesDir(admin.username), file);
        if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
          fs.renameSync(srcPath, destPath);
          console.log(`Moved note: ${file}`);
        }
      }
    }

    // Move backups
    if (fs.existsSync(oldBackupsDir)) {
      const backupFiles = fs.readdirSync(oldBackupsDir).filter(f => f.endsWith('.zip'));
      for (const file of backupFiles) {
        const srcPath = path.join(oldBackupsDir, file);
        const destPath = path.join(getUserBackupsDir(admin.username), file);
        if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
          fs.renameSync(srcPath, destPath);
          console.log(`Moved backup: ${file}`);
        }
      }
    }

    // Mark migration complete
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('data_migrated_to_users', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'"
    );

    console.log('Data migration to admin complete');
  } catch (error) {
    console.error('Error migrating existing data:', error);
  }
}

// Database will be initialized on startup
initDatabase()
  .then(() => syncCategoryFolders())
  .then(() => initializeAdmin())
  .then(() => migratePatternOwnership())
  .then(() => migrateCategoriesToPerUser())
  .then(() => migrateExistingDataToAdmin())
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// Routes

// Get all patterns with their hashtags (excludes archived)
app.get('/api/patterns', async (req, res) => {
  try {
    let result;
    if (req.user?.role === 'admin') {
      // Admin sees all patterns
      result = await pool.query(
        'SELECT * FROM patterns WHERE is_archived = false OR is_archived IS NULL ORDER BY upload_date DESC'
      );
    } else if (req.user?.id) {
      // Regular user sees own patterns + public patterns
      result = await pool.query(
        `SELECT * FROM patterns
         WHERE (is_archived = false OR is_archived IS NULL)
         AND (user_id = $1 OR visibility = 'public' OR user_id IS NULL)
         ORDER BY upload_date DESC`,
        [req.user.id]
      );
    } else {
      // No user (shouldn't happen with auth middleware, but fallback)
      result = await pool.query(
        `SELECT * FROM patterns
         WHERE (is_archived = false OR is_archived IS NULL)
         AND visibility = 'public'
         ORDER BY upload_date DESC`
      );
    }

    // Fetch hashtags for each pattern
    const patterns = await Promise.all(result.rows.map(async (pattern) => {
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.pattern_id = $1
         ORDER BY h.name`,
        [pattern.id]
      );
      return { ...pattern, hashtags: hashtagsResult.rows };
    }));

    res.json(patterns);
  } catch (error) {
    console.error('Error fetching patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload a new pattern
app.post('/api/patterns', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const name = req.body.name || req.file.originalname.replace('.pdf', '');
    const category = req.body.category || 'Amigurumi';
    const description = req.body.description || '';
    const isCurrent = req.body.isCurrent === 'true' || req.body.isCurrent === true;

    console.log('Upload received:');
    console.log('  - req.body.name:', req.body.name);
    console.log('  - computed name:', name);
    console.log('  - req.file.filename:', req.file.filename);
    console.log('  - req.file.originalname:', req.file.originalname);

    // Ensure user directories exist
    const username = req.user.username;
    await ensureUserDirectories(username);

    // Now we have access to req.body! Determine the final filename
    const categoryDir = getCategoryDir(username, category);

    let finalFilename;
    if (req.body.name) {
      // User provided a custom name
      const sanitized = sanitizeFilename(req.body.name);
      finalFilename = getUniqueFilename(categoryDir, sanitized, '.pdf');
    } else {
      // No custom name, use original filename
      finalFilename = req.file.originalname;
    }

    // Create category directory only when we're about to move a file there
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    // Move file from temp location to category folder with final name
    // Use copy+delete instead of rename to handle cross-device moves (Docker volumes)
    const tempPath = req.file.path;
    const finalPath = path.join(categoryDir, finalFilename);
    fs.copyFileSync(tempPath, finalPath);
    fs.unlinkSync(tempPath);

    console.log(`Moved file from ${tempPath} to ${finalPath}`);

    // Generate thumbnail from PDF
    const pdfPath = finalPath;
    const thumbnailFilename = `thumb-${category}-${finalFilename}.jpg`;
    const thumbnail = await generateThumbnail(pdfPath, thumbnailFilename, username);

    const userId = req.user.id;
    const result = await pool.query(
      `INSERT INTO patterns (name, filename, original_name, category, description, is_current, thumbnail, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name, finalFilename, req.file.originalname, category, description, isCurrent, thumbnail, userId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new markdown pattern
app.post('/api/patterns/markdown', async (req, res) => {
  try {
    const { name, category, description, content, isCurrent, hashtagIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Pattern name is required' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Pattern content is required' });
    }

    const patternCategory = category || 'Amigurumi';
    const patternDescription = description || '';
    const patternIsCurrent = isCurrent === true || isCurrent === 'true';

    // Ensure user directories exist
    const username = req.user.username;
    await ensureUserDirectories(username);

    // Create category directory if needed
    const categoryDir = ensureCategoryDir(username, patternCategory);

    // Create a unique filename based on the pattern name
    const sanitizedName = sanitizeFilename(name);
    const filename = getUniqueFilename(categoryDir, sanitizedName, '.md');

    // Save the markdown file to disk
    const filePath = path.join(categoryDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');

    const userId = req.user.id;
    const result = await pool.query(
      `INSERT INTO patterns (name, filename, original_name, category, description, is_current, pattern_type, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'markdown', $7)
       RETURNING *`,
      [name.trim(), filename, filename, patternCategory, patternDescription, patternIsCurrent, userId]
    );

    const pattern = result.rows[0];

    // Save hashtags if provided
    if (hashtagIds && hashtagIds.length > 0) {
      for (const hashtagId of hashtagIds) {
        await pool.query(
          'INSERT INTO pattern_hashtags (pattern_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [pattern.id, hashtagId]
        );
      }
    }

    // Fetch hashtags to include in response
    const hashtagsResult = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [pattern.id]
    );

    res.json({ ...pattern, hashtags: hashtagsResult.rows });
  } catch (error) {
    console.error('Error creating markdown pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get markdown content for a pattern
app.get('/api/patterns/:id/content', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    if (pattern.pattern_type !== 'markdown') {
      return res.status(400).json({ error: 'Pattern is not a markdown pattern' });
    }

    // Read content from file
    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let filePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Pattern file not found' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content });
  } catch (error) {
    console.error('Error fetching pattern content:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update markdown content for a pattern
app.put('/api/patterns/:id/content', async (req, res) => {
  try {
    const { content } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }
    if (pattern.pattern_type !== 'markdown') {
      return res.status(400).json({ error: 'Pattern is not a markdown pattern' });
    }

    // Write content to file
    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let filePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);
    if (!fs.existsSync(path.dirname(filePath))) {
      filePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
    }

    fs.writeFileSync(filePath, content || '', 'utf8');

    // Update timestamp in database
    await pool.query(
      'UPDATE patterns SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [req.params.id]
    );

    res.json({ content: content || '' });
  } catch (error) {
    console.error('Error updating pattern content:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific pattern PDF (must come before /api/patterns/:id)
app.get('/api/patterns/:id/file', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let dir = getCategoryDir(ownerUsername, pattern.category);
    if (!fs.existsSync(path.join(dir, pattern.filename))) {
      dir = getUserPatternsDir(ownerUsername);
      if (!fs.existsSync(path.join(dir, pattern.filename))) {
        return res.status(404).json({ error: 'File not found' });
      }
    }

    // Serve annotated version if it exists, otherwise the original
    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    const annotatedPath = path.join(dir, annotatedName);
    const filePath = fs.existsSync(annotatedPath) ? annotatedPath : path.join(dir, pattern.filename);

    // Prevent browser from serving stale cached PDFs (annotations would be lost)
    res.set('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error fetching pattern file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save annotated PDF (writes to .annotated.pdf, original is never modified)
app.put('/api/patterns/:id/file', express.raw({ type: 'application/pdf', limit: '100mb' }), async (req, res) => {
  try {
    const pattern = await verifyPatternOwnership(req.params.id, req.user.id, req.user.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let dir = getCategoryDir(ownerUsername, pattern.category);
    if (!fs.existsSync(path.join(dir, pattern.filename))) {
      dir = getUserPatternsDir(ownerUsername);
    }

    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    fs.writeFileSync(path.join(dir, annotatedName), req.body);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving annotated PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Revert annotations (delete the .annotated.pdf, restoring original)
// Check if annotated version exists
app.get('/api/patterns/:id/annotations', async (req, res) => {
  try {
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) return res.status(403).json({ error: 'Not authorized' });

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let dir = getCategoryDir(ownerUsername, pattern.category);
    if (!fs.existsSync(path.join(dir, pattern.filename))) {
      dir = getUserPatternsDir(ownerUsername);
    }

    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    res.json({ hasAnnotations: fs.existsSync(path.join(dir, annotatedName)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/patterns/:id/annotations', async (req, res) => {
  try {
    const pattern = await verifyPatternOwnership(req.params.id, req.user.id, req.user.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let dir = getCategoryDir(ownerUsername, pattern.category);
    if (!fs.existsSync(path.join(dir, pattern.filename))) {
      dir = getUserPatternsDir(ownerUsername);
    }

    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    const annotatedPath = path.join(dir, annotatedName);
    if (fs.existsSync(annotatedPath)) {
      fs.unlinkSync(annotatedPath);
      return res.json({ success: true, reverted: true });
    }
    res.json({ success: true, reverted: false });
  } catch (error) {
    console.error('Error reverting annotations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a pattern thumbnail
app.get('/api/patterns/:id/thumbnail', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    if (!pattern.thumbnail) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    // Use owner's thumbnail directory (fallback to admin if no owner)
    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), pattern.thumbnail);

    if (!fs.existsSync(thumbnailPath)) {
      return res.status(404).json({ error: 'Thumbnail file not found' });
    }

    res.sendFile(thumbnailPath);
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current patterns (must come before /api/patterns/:id)
app.get('/api/patterns/current', async (req, res) => {
  try {
    let result;
    if (req.user?.role === 'admin') {
      result = await pool.query(
        'SELECT * FROM patterns WHERE is_current = true AND (is_archived = false OR is_archived IS NULL) ORDER BY updated_at DESC'
      );
    } else if (req.user?.id) {
      result = await pool.query(
        `SELECT * FROM patterns
         WHERE is_current = true AND (is_archived = false OR is_archived IS NULL)
         AND (user_id = $1 OR visibility = 'public' OR user_id IS NULL)
         ORDER BY updated_at DESC`,
        [req.user.id]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM patterns
         WHERE is_current = true AND (is_archived = false OR is_archived IS NULL)
         AND visibility = 'public'
         ORDER BY updated_at DESC`
      );
    }

    // Fetch hashtags for each pattern
    const patterns = await Promise.all(result.rows.map(async (pattern) => {
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.pattern_id = $1
         ORDER BY h.name`,
        [pattern.id]
      );
      return { ...pattern, hashtags: hashtagsResult.rows };
    }));

    res.json(patterns);
  } catch (error) {
    console.error('Error fetching current patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all archived patterns (must come before /api/patterns/:id)
app.get('/api/patterns/archived', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE is_archived = true ORDER BY archived_at DESC'
    );

    // Fetch hashtags for each pattern
    const patterns = await Promise.all(result.rows.map(async (pattern) => {
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.pattern_id = $1
         ORDER BY h.name`,
        [pattern.id]
      );
      return { ...pattern, hashtags: hashtagsResult.rows };
    }));

    res.json(patterns);
  } catch (error) {
    console.error('Error fetching archived patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Permanently delete all archived patterns (must come before /api/patterns/:id)
app.delete('/api/patterns/archived/all', async (req, res) => {
  try {
    // Get archived patterns with owner info
    const result = await pool.query(`
      SELECT p.*, u.username as owner_username
      FROM patterns p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.is_archived = true
    `);

    let deletedCount = 0;

    for (const pattern of result.rows) {
      const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';

      // Delete file from archive
      const archiveFilePath = path.join(getArchiveCategoryDir(ownerUsername, pattern.category), pattern.filename);
      if (fs.existsSync(archiveFilePath)) {
        fs.unlinkSync(archiveFilePath);
      }

      // Delete thumbnail from archive
      if (pattern.thumbnail) {
        const thumbnailPath = path.join(getUserArchiveThumbnailsDir(ownerUsername), pattern.thumbnail);
        if (fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
      }

      deletedCount++;
    }

    // Delete all archived patterns from database
    await pool.query('DELETE FROM patterns WHERE is_archived = true');

    // Clean up all empty archive directories
    cleanupEmptyArchiveCategories();

    res.json({ message: `${deletedCount} pattern${deletedCount !== 1 ? 's' : ''} permanently deleted` });
  } catch (error) {
    console.error('Error deleting all archived patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a single pattern by ID (must come after all /api/patterns/:id/something routes)
app.get('/api/patterns/:id', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    // Fetch hashtags for the pattern
    const hashtagsResult = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [req.params.id]
    );

    res.json({ ...pattern, hashtags: hashtagsResult.rows });
  } catch (error) {
    console.error('Error fetching pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Track pattern opened
app.post('/api/patterns/:id/opened', async (req, res) => {
  try {
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) return res.status(403).json({ error: 'Not authorized' });
    await pool.query('UPDATE patterns SET last_opened_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating last_opened_at:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get pattern info (metadata including file size)
app.get('/api/patterns/:id/info', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let filePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
    }

    let fileSize = 0;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      fileSize = stats.size;
    }

    // Extract PDF metadata if it's a PDF
    let pdfMetadata = null;
    if (pattern.pattern_type === 'pdf' && fs.existsSync(filePath)) {
      try {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(dataBuffer);
        pdfMetadata = {
          title: pdfData.info?.Title || null,
          author: pdfData.info?.Author || null,
          subject: pdfData.info?.Subject || null,
          creator: pdfData.info?.Creator || null,
          producer: pdfData.info?.Producer || null,
          creationDate: pdfData.info?.CreationDate || null,
          modDate: pdfData.info?.ModDate || null,
          pageCount: pdfData.numpages || null
        };
      } catch (pdfError) {
        console.error('Error parsing PDF metadata:', pdfError.message);
      }
    }

    res.json({
      id: pattern.id,
      name: pattern.name,
      filename: pattern.filename,
      category: pattern.category,
      pattern_type: pattern.pattern_type,
      description: pattern.description,
      upload_date: pattern.upload_date,
      completed: pattern.completed,
      completed_date: pattern.completed_date,
      timer_seconds: pattern.timer_seconds,
      is_current: pattern.is_current,
      file_size: fileSize,
      file_path: filePath,
      pdf_metadata: pdfMetadata
    });
  } catch (error) {
    console.error('Error fetching pattern info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update pattern details
app.patch('/api/patterns/:id', async (req, res) => {
  try {
    console.log('PATCH request body:', req.body);
    const { name, description, category } = req.body;
    console.log('Extracted values:', { name, description, category });

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    // Get owner username for paths
    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let newFilename = pattern.filename;

    // Determine the working category (use new category if changing, otherwise current)
    const workingCategory = category !== undefined ? category : pattern.category;
    const categoryDir = getCategoryDir(ownerUsername, workingCategory);

    // Find current file location (check category folder first, then root)
    let oldFilePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);
    console.log(`Checking for file at: ${oldFilePath}`);

    if (!fs.existsSync(oldFilePath)) {
      oldFilePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
      console.log(`Not found, checking user root: ${oldFilePath}`);
    }

    if (!fs.existsSync(oldFilePath)) {
      console.log(`File not found at ${oldFilePath}, skipping file operations`);
    } else {
      console.log(`File found at: ${oldFilePath}`);

      // If name is being changed, rename the file
      if (name !== undefined && name !== pattern.name) {
        console.log(`Name changing from "${pattern.name}" to "${name}"`);

        // Generate new filename from the new name
        const sanitized = sanitizeFilename(name);
        const extension = path.extname(pattern.filename);
        newFilename = getUniqueFilename(categoryDir, sanitized, extension);
        console.log(`New filename will be: ${newFilename}`);
      }

      // If category is being changed, move the file
      if (category !== undefined && category !== pattern.category) {
        console.log(`Category changing from "${pattern.category}" to "${category}"`);
      }

      // Perform the file move/rename if needed
      const newFilePath = path.join(categoryDir, newFilename);
      if (oldFilePath !== newFilePath) {
        // Create category directory only when we're about to move a file there
        if (!fs.existsSync(categoryDir)) {
          fs.mkdirSync(categoryDir, { recursive: true });
          console.log(`Created directory: ${categoryDir}`);
        }

        fs.renameSync(oldFilePath, newFilePath);
        console.log(`Successfully moved/renamed file from ${oldFilePath} to ${newFilePath}`);

        // Update thumbnail filename if it exists
        if (pattern.thumbnail && newFilename !== pattern.filename) {
          const userThumbnailsDir = getUserThumbnailsDir(ownerUsername);
          const oldThumbnailPath = path.join(userThumbnailsDir, pattern.thumbnail);
          if (fs.existsSync(oldThumbnailPath)) {
            const newThumbnailFilename = `thumb-${workingCategory}-${newFilename}.jpg`;
            const newThumbnailPath = path.join(userThumbnailsDir, newThumbnailFilename);
            fs.renameSync(oldThumbnailPath, newThumbnailPath);
            console.log(`Renamed thumbnail from ${pattern.thumbnail} to ${newThumbnailFilename}`);

            // Update thumbnail in database
            await pool.query(
              'UPDATE patterns SET thumbnail = $1 WHERE id = $2',
              [newThumbnailFilename, req.params.id]
            );
          }
        }
      }
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }

    // Update filename if it changed
    if (newFilename !== pattern.filename) {
      updates.push(`filename = $${paramCount++}`);
      values.push(newFilename);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    const query = `
      UPDATE patterns
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    // Clean up empty category directories after potential category change
    await cleanupEmptyCategories();

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a pattern
app.delete('/api/patterns/:id', async (req, res) => {
  try {
    // Verify ownership before allowing deletion
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to delete this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    let filePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);

    // Delete the file (check category folder first, then user root for legacy files)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    } else {
      filePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    // Also delete the annotated version if it exists
    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    const annotatedPath = path.join(path.dirname(filePath), annotatedName);
    if (fs.existsSync(annotatedPath)) {
      fs.unlinkSync(annotatedPath);
    }

    // Delete the thumbnail
    if (pattern.thumbnail) {
      const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), pattern.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }

    await pool.query('DELETE FROM patterns WHERE id = $1', [req.params.id]);

    // Clean up empty category directories after deletion
    await cleanupEmptyCategories();

    res.json({ message: 'Pattern deleted successfully' });
  } catch (error) {
    console.error('Error deleting pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Archive a pattern (move to archive instead of deleting)
app.post('/api/patterns/:id/archive', async (req, res) => {
  try {
    // Verify ownership before allowing archive
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to archive this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';

    // Find current file location
    let filePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
    }

    // Ensure archive category directory exists
    const archiveCategoryDir = ensureArchiveCategoryDir(ownerUsername, pattern.category);

    // Move pattern file to archive (use copy+delete for cross-device support)
    if (fs.existsSync(filePath)) {
      const archiveFilePath = path.join(archiveCategoryDir, pattern.filename);
      fs.copyFileSync(filePath, archiveFilePath);
      fs.unlinkSync(filePath);
    }
    // Also move annotated version if it exists
    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    const annotatedPath = path.join(path.dirname(filePath), annotatedName);
    if (fs.existsSync(annotatedPath)) {
      fs.copyFileSync(annotatedPath, path.join(archiveCategoryDir, annotatedName));
      fs.unlinkSync(annotatedPath);
    }

    // Move thumbnail to archive if exists
    if (pattern.thumbnail) {
      const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), pattern.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        const archiveThumbnailPath = path.join(getUserArchiveThumbnailsDir(ownerUsername), pattern.thumbnail);
        if (!fs.existsSync(getUserArchiveThumbnailsDir(ownerUsername))) {
          fs.mkdirSync(getUserArchiveThumbnailsDir(ownerUsername), { recursive: true });
        }
        fs.copyFileSync(thumbnailPath, archiveThumbnailPath);
        fs.unlinkSync(thumbnailPath);
      }
    }

    // Update database - mark as archived
    await pool.query(
      `UPDATE patterns
       SET is_archived = true, archived_at = CURRENT_TIMESTAMP, is_current = false
       WHERE id = $1`,
      [req.params.id]
    );

    // Clean up empty category directories
    await cleanupEmptyCategories();

    res.json({ message: 'Pattern archived successfully' });
  } catch (error) {
    console.error('Error archiving pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore a pattern from archive
app.post('/api/patterns/:id/restore', async (req, res) => {
  try {
    // Verify ownership before allowing restore
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to restore this pattern' });
    }

    if (!pattern.is_archived) {
      return res.status(404).json({ error: 'Archived pattern not found' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';

    // Ensure target category directory exists
    const categoryDir = ensureCategoryDir(ownerUsername, pattern.category);

    // Move pattern file from archive back to patterns (use copy+delete for cross-device support)
    const archiveFilePath = path.join(getArchiveCategoryDir(ownerUsername, pattern.category), pattern.filename);
    if (fs.existsSync(archiveFilePath)) {
      const filePath = path.join(categoryDir, pattern.filename);
      fs.copyFileSync(archiveFilePath, filePath);
      fs.unlinkSync(archiveFilePath);
    }
    // Also move annotated version if it exists
    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    const annotatedArchivePath = path.join(getArchiveCategoryDir(ownerUsername, pattern.category), annotatedName);
    if (fs.existsSync(annotatedArchivePath)) {
      fs.copyFileSync(annotatedArchivePath, path.join(categoryDir, annotatedName));
      fs.unlinkSync(annotatedArchivePath);
    }

    // Move thumbnail from archive
    if (pattern.thumbnail) {
      const archiveThumbnailPath = path.join(getUserArchiveThumbnailsDir(ownerUsername), pattern.thumbnail);
      if (fs.existsSync(archiveThumbnailPath)) {
        const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), pattern.thumbnail);
        fs.copyFileSync(archiveThumbnailPath, thumbnailPath);
        fs.unlinkSync(archiveThumbnailPath);
      }
    }

    // Update database - mark as not archived
    await pool.query(
      `UPDATE patterns
       SET is_archived = false, archived_at = NULL
       WHERE id = $1`,
      [req.params.id]
    );

    // Clean up empty archive directories
    cleanupEmptyArchiveCategories();

    res.json({ message: 'Pattern restored successfully' });
  } catch (error) {
    console.error('Error restoring pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Permanently delete an archived pattern
app.delete('/api/patterns/:id/permanent', async (req, res) => {
  try {
    // Verify ownership before allowing permanent deletion
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to delete this pattern' });
    }

    if (!pattern.is_archived) {
      return res.status(404).json({ error: 'Archived pattern not found' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';

    // Delete file from archive
    const archiveFilePath = path.join(getArchiveCategoryDir(ownerUsername, pattern.category), pattern.filename);
    if (fs.existsSync(archiveFilePath)) {
      fs.unlinkSync(archiveFilePath);
    }
    // Also delete the annotated version if it exists
    const annotatedName = pattern.filename.replace(/\.pdf$/i, '.annotated.pdf');
    const annotatedArchivePath = path.join(path.dirname(archiveFilePath), annotatedName);
    if (fs.existsSync(annotatedArchivePath)) {
      fs.unlinkSync(annotatedArchivePath);
    }

    // Delete thumbnail from archive
    if (pattern.thumbnail) {
      const thumbnailPath = path.join(getUserArchiveThumbnailsDir(ownerUsername), pattern.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }

    // Delete from database
    await pool.query('DELETE FROM patterns WHERE id = $1', [req.params.id]);

    // Clean up empty archive directories
    cleanupEmptyArchiveCategories();

    res.json({ message: 'Pattern permanently deleted' });
  } catch (error) {
    console.error('Error permanently deleting pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all available categories for editing/uploading (current user's categories)
app.get('/api/categories/all', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      'SELECT name FROM categories WHERE user_id = $1 ORDER BY name',
      [userId]
    );
    const categories = result.rows.map(row => row.name);
    res.json(categories);
  } catch (error) {
    console.error('Error fetching all categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get populated categories (only those with patterns) with counts for filtering
app.get('/api/categories', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Query database for categories with pattern counts (for current user's patterns)
    const result = await pool.query(
      `SELECT category, COUNT(*) as count
       FROM patterns
       WHERE user_id = $1
       GROUP BY category
       ORDER BY category`,
      [userId]
    );
    const categoriesWithCounts = result.rows.map(row => ({
      name: row.category,
      count: parseInt(row.count)
    }));
    res.json(categoriesWithCounts);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add a new category
app.post('/api/categories', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    // Get the next position for this user's categories
    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM categories WHERE user_id = $1',
      [userId]
    );
    const nextPos = posResult.rows[0].next_pos;

    await pool.query(
      'INSERT INTO categories (name, user_id, position) VALUES ($1, $2, $3)',
      [name.trim(), userId, nextPos]
    );

    res.status(201).json({ message: 'Category created', name: name.trim() });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Category already exists' });
    }
    console.error('Error creating category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a category name
app.put('/api/categories/:name', async (req, res) => {
  try {
    const userId = req.user?.id;
    const username = req.user?.username;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const oldName = req.params.name;
    const { name: newName } = req.body;

    if (!newName || !newName.trim()) {
      return res.status(400).json({ error: 'New category name is required' });
    }

    // Update the category name (only for this user)
    const result = await pool.query(
      'UPDATE categories SET name = $1 WHERE name = $2 AND user_id = $3 RETURNING *',
      [newName.trim(), oldName, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Update all of this user's patterns with this category
    await pool.query(
      'UPDATE patterns SET category = $1 WHERE category = $2 AND user_id = $3',
      [newName.trim(), oldName, userId]
    );

    // Rename the category folder for this user only
    renameCategoryDir(username, oldName, newName.trim());

    res.json({ message: 'Category updated', oldName, newName: newName.trim() });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Category name already exists' });
    }
    console.error('Error updating category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a category
app.delete('/api/categories/:name', async (req, res) => {
  try {
    const userId = req.user?.id;
    const username = req.user?.username;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name } = req.params;

    // Check if any of this user's patterns use this category
    const patternCheck = await pool.query(
      'SELECT COUNT(*) FROM patterns WHERE category = $1 AND user_id = $2',
      [name, userId]
    );

    if (parseInt(patternCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete category with existing patterns' });
    }

    const result = await pool.query(
      'DELETE FROM categories WHERE name = $1 AND user_id = $2 RETURNING *',
      [name, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Remove the category folder for this user (if empty)
    removeCategoryDir(username, name);

    res.json({ message: 'Category deleted', name });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Hashtag endpoints

// Get all hashtags
app.get('/api/hashtags', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hashtags ORDER BY position, name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add a new hashtag
app.post('/api/hashtags', async (req, res) => {
  try {
    let { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Hashtag name is required' });
    }

    // Remove # if provided and normalize
    name = name.trim().replace(/^#/, '').toLowerCase();

    // Get the next position
    const posResult = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM hashtags');
    const nextPos = posResult.rows[0].next_pos;

    const result = await pool.query(
      'INSERT INTO hashtags (name, position) VALUES ($1, $2) RETURNING *',
      [name, nextPos]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Hashtag already exists' });
    }
    console.error('Error creating hashtag:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a hashtag name
app.put('/api/hashtags/:id', async (req, res) => {
  try {
    let { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'New hashtag name is required' });
    }

    name = name.trim().replace(/^#/, '').toLowerCase();

    const result = await pool.query(
      'UPDATE hashtags SET name = $1 WHERE id = $2 RETURNING *',
      [name, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Hashtag not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Hashtag name already exists' });
    }
    console.error('Error updating hashtag:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a hashtag
app.delete('/api/hashtags/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM hashtags WHERE id = $1 RETURNING *', [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Hashtag not found' });
    }

    res.json({ message: 'Hashtag deleted' });
  } catch (error) {
    console.error('Error deleting hashtag:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get hashtags for a pattern
app.get('/api/patterns/:id/hashtags', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    const result = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pattern hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set hashtags for a pattern (replaces existing)
app.put('/api/patterns/:id/hashtags', async (req, res) => {
  try {
    const { hashtagIds } = req.body;
    const patternId = req.params.id;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(patternId, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    // Delete existing associations
    await pool.query('DELETE FROM pattern_hashtags WHERE pattern_id = $1', [patternId]);

    // Insert new associations
    if (hashtagIds && hashtagIds.length > 0) {
      for (const hashtagId of hashtagIds) {
        await pool.query(
          'INSERT INTO pattern_hashtags (pattern_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [patternId, hashtagId]
        );
      }
    }

    // Return updated hashtags
    const result = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [patternId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error setting pattern hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Project endpoints
// ============================================

// Get all projects with pattern counts and cumulative time
app.get('/api/projects', async (req, res) => {
  try {
    let result;
    if (req.user?.role === 'admin') {
      result = await pool.query(
        'SELECT * FROM projects WHERE is_archived = false OR is_archived IS NULL ORDER BY created_at DESC'
      );
    } else if (req.user?.id) {
      result = await pool.query(
        `SELECT * FROM projects
         WHERE (is_archived = false OR is_archived IS NULL)
         AND user_id = $1
         ORDER BY created_at DESC`,
        [req.user.id]
      );
    } else {
      return res.json([]);
    }

    // Fetch hashtags, pattern counts, and cumulative time for each project
    const projects = await Promise.all(result.rows.map(async (project) => {
      // Get hashtags
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN project_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.project_id = $1
         ORDER BY h.name`,
        [project.id]
      );

      // Get pattern count and cumulative time
      const statsResult = await pool.query(
        `SELECT
           COUNT(pp.id) as pattern_count,
           COUNT(CASE WHEN pp.status = 'completed' THEN 1 END) as completed_count,
           COUNT(CASE WHEN pp.status = 'in_progress' THEN 1 END) as in_progress_count,
           COALESCE(SUM(p.timer_seconds), 0) as total_timer_seconds
         FROM project_patterns pp
         JOIN patterns p ON pp.pattern_id = p.id
         WHERE pp.project_id = $1`,
        [project.id]
      );

      const stats = statsResult.rows[0];

      return {
        ...project,
        hashtags: hashtagsResult.rows,
        pattern_count: parseInt(stats.pattern_count) || 0,
        completed_count: parseInt(stats.completed_count) || 0,
        in_progress_count: parseInt(stats.in_progress_count) || 0,
        total_timer_seconds: parseInt(stats.total_timer_seconds) || 0
      };
    }));

    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current projects (marked as current)
app.get('/api/projects/current', async (req, res) => {
  try {
    let result;
    if (req.user?.role === 'admin') {
      result = await pool.query(
        'SELECT * FROM projects WHERE is_current = true AND (is_archived = false OR is_archived IS NULL) ORDER BY updated_at DESC'
      );
    } else if (req.user?.id) {
      result = await pool.query(
        `SELECT * FROM projects
         WHERE is_current = true
         AND (is_archived = false OR is_archived IS NULL)
         AND user_id = $1
         ORDER BY updated_at DESC`,
        [req.user.id]
      );
    } else {
      return res.json([]);
    }

    // Fetch hashtags and stats for each project
    const projects = await Promise.all(result.rows.map(async (project) => {
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN project_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.project_id = $1
         ORDER BY h.name`,
        [project.id]
      );

      const statsResult = await pool.query(
        `SELECT
           COUNT(pp.id) as pattern_count,
           COUNT(CASE WHEN pp.status = 'completed' THEN 1 END) as completed_count,
           COUNT(CASE WHEN pp.status = 'in_progress' THEN 1 END) as in_progress_count,
           COALESCE(SUM(p.timer_seconds), 0) as total_timer_seconds
         FROM project_patterns pp
         JOIN patterns p ON pp.pattern_id = p.id
         WHERE pp.project_id = $1`,
        [project.id]
      );

      const stats = statsResult.rows[0];

      return {
        ...project,
        hashtags: hashtagsResult.rows,
        pattern_count: parseInt(stats.pattern_count) || 0,
        completed_count: parseInt(stats.completed_count) || 0,
        in_progress_count: parseInt(stats.in_progress_count) || 0,
        total_timer_seconds: parseInt(stats.total_timer_seconds) || 0
      };
    }));

    res.json(projects);
  } catch (error) {
    console.error('Error fetching current projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get archived projects (must be before :id route)
app.get('/api/projects/archived', async (req, res) => {
  try {
    let result;
    if (req.user?.role === 'admin') {
      result = await pool.query(
        'SELECT * FROM projects WHERE is_archived = true ORDER BY archived_at DESC'
      );
    } else if (req.user?.id) {
      result = await pool.query(
        'SELECT * FROM projects WHERE is_archived = true AND user_id = $1 ORDER BY archived_at DESC',
        [req.user.id]
      );
    } else {
      return res.json([]);
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching archived projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single project with patterns
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await verifyProjectReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to access this project' });
    }

    // Get hashtags
    const hashtagsResult = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN project_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.project_id = $1
       ORDER BY h.name`,
      [project.id]
    );

    // Get patterns with their project-specific status
    const patternsResult = await pool.query(
      `SELECT p.*, pp.position, pp.status as project_status, pp.added_at
       FROM patterns p
       JOIN project_patterns pp ON p.id = pp.pattern_id
       WHERE pp.project_id = $1
       ORDER BY pp.position ASC`,
      [project.id]
    );

    // Get cumulative stats
    const statsResult = await pool.query(
      `SELECT
         COUNT(pp.id) as pattern_count,
         COUNT(CASE WHEN pp.status = 'completed' THEN 1 END) as completed_count,
         COUNT(CASE WHEN pp.status = 'in_progress' THEN 1 END) as in_progress_count,
         COALESCE(SUM(p.timer_seconds), 0) as total_timer_seconds
       FROM project_patterns pp
       JOIN patterns p ON pp.pattern_id = p.id
       WHERE pp.project_id = $1`,
      [project.id]
    );

    const stats = statsResult.rows[0];

    res.json({
      ...project,
      hashtags: hashtagsResult.rows,
      patterns: patternsResult.rows,
      pattern_count: parseInt(stats.pattern_count) || 0,
      completed_count: parseInt(stats.completed_count) || 0,
      in_progress_count: parseInt(stats.in_progress_count) || 0,
      total_timer_seconds: parseInt(stats.total_timer_seconds) || 0
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, description, hashtagIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    const userId = req.user.id;

    const result = await pool.query(
      `INSERT INTO projects (user_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, name.trim(), description || '']
    );

    const project = result.rows[0];

    // Save hashtags if provided
    if (hashtagIds && hashtagIds.length > 0) {
      for (const hashtagId of hashtagIds) {
        await pool.query(
          'INSERT INTO project_hashtags (project_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [project.id, hashtagId]
        );
      }
    }

    // Fetch hashtags to include in response
    const hashtagsResult = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN project_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.project_id = $1
       ORDER BY h.name`,
      [project.id]
    );

    res.json({
      ...project,
      hashtags: hashtagsResult.rows,
      pattern_count: 0,
      completed_count: 0,
      total_timer_seconds: 0
    });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update project details
app.patch('/api/projects/:id', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    const { name, description } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      values.push(name.trim());
      paramCount++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(description);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.json(project);
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE projects SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Track project opened
app.post('/api/projects/:id/opened', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) return res.status(403).json({ error: 'Not authorized' });
    await pool.query('UPDATE projects SET last_opened_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating project last_opened_at:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a project (patterns remain in library)
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to delete this project' });
    }

    // Delete project (cascade will remove project_patterns and project_hashtags)
    await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);

    // Delete project thumbnail if exists
    if (project.thumbnail) {
      const ownerUsername = project.owner_username || req.user.username;
      const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), project.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }

    // Delete project notes if exists
    const ownerUsername = project.owner_username || req.user.username;
    const notesDir = getUserProjectNotesDir(ownerUsername);
    const notesFilename = 'project-' + sanitizeNotesFilename(project.name) + '.md';
    const notesPath = path.join(notesDir, notesFilename);
    if (fs.existsSync(notesPath)) {
      fs.unlinkSync(notesPath);
    }

    res.json({ message: 'Project deleted' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle project current status
app.patch('/api/projects/:id/current', async (req, res) => {
  try {
    const { isCurrent } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    // When marking as current, un-complete it
    const result = await pool.query(
      `UPDATE projects
       SET is_current = $1,
           completed = CASE WHEN $1 = true THEN false ELSE completed END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [isCurrent, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling project current:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle project favorite status
app.patch('/api/projects/:id/favorite', async (req, res) => {
  try {
    const { isFavorite } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    const result = await pool.query(
      `UPDATE projects
       SET is_favorite = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [isFavorite, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling project favorite:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle project complete status
app.patch('/api/projects/:id/complete', async (req, res) => {
  try {
    const { completed } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    const result = await pool.query(
      `UPDATE projects
       SET completed = $1,
           completed_date = CASE WHEN $1 = true THEN CURRENT_TIMESTAMP ELSE NULL END,
           is_current = CASE WHEN $1 = true THEN false ELSE is_current END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [completed, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling project complete:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get patterns in a project (ordered)
app.get('/api/projects/:id/patterns', async (req, res) => {
  try {
    const project = await verifyProjectReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to access this project' });
    }

    const result = await pool.query(
      `SELECT p.*, pp.position, pp.status as project_status, pp.added_at
       FROM patterns p
       JOIN project_patterns pp ON p.id = pp.pattern_id
       WHERE pp.project_id = $1
       ORDER BY pp.position ASC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching project patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add pattern(s) to a project
app.post('/api/projects/:id/patterns', async (req, res) => {
  try {
    const { patternIds } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    if (!patternIds || !Array.isArray(patternIds) || patternIds.length === 0) {
      return res.status(400).json({ error: 'Pattern IDs are required' });
    }

    // Get the max position for this project
    const maxPosResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM project_patterns WHERE project_id = $1',
      [req.params.id]
    );
    let position = maxPosResult.rows[0].max_pos + 1;

    // Add each pattern
    for (const patternId of patternIds) {
      // Verify user has access to this pattern
      const pattern = await verifyPatternReadAccess(patternId, req.user?.id, req.user?.role === 'admin');
      if (pattern) {
        await pool.query(
          `INSERT INTO project_patterns (project_id, pattern_id, position, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (project_id, pattern_id) DO NOTHING`,
          [req.params.id, patternId, position]
        );
        position++;
      }
    }

    // Return updated patterns list
    const result = await pool.query(
      `SELECT p.*, pp.position, pp.status as project_status, pp.added_at
       FROM patterns p
       JOIN project_patterns pp ON p.id = pp.pattern_id
       WHERE pp.project_id = $1
       ORDER BY pp.position ASC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error adding patterns to project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove a pattern from a project
app.delete('/api/projects/:id/patterns/:patternId', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    await pool.query(
      'DELETE FROM project_patterns WHERE project_id = $1 AND pattern_id = $2',
      [req.params.id, req.params.patternId]
    );

    res.json({ message: 'Pattern removed from project' });
  } catch (error) {
    console.error('Error removing pattern from project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reorder patterns in a project
app.patch('/api/projects/:id/patterns/reorder', async (req, res) => {
  try {
    const { patternIds } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    if (!patternIds || !Array.isArray(patternIds)) {
      return res.status(400).json({ error: 'Pattern IDs array is required' });
    }

    // Update positions based on array order
    for (let i = 0; i < patternIds.length; i++) {
      await pool.query(
        'UPDATE project_patterns SET position = $1 WHERE project_id = $2 AND pattern_id = $3',
        [i, req.params.id, patternIds[i]]
      );
    }

    // Return updated patterns list
    const result = await pool.query(
      `SELECT p.*, pp.position, pp.status as project_status, pp.added_at
       FROM patterns p
       JOIN project_patterns pp ON p.id = pp.pattern_id
       WHERE pp.project_id = $1
       ORDER BY pp.position ASC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error reordering project patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update pattern status within a project
app.patch('/api/projects/:id/patterns/:patternId/status', async (req, res) => {
  try {
    const { status } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    const validStatuses = ['pending', 'in_progress', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: pending, in_progress, or completed' });
    }

    await pool.query(
      'UPDATE project_patterns SET status = $1 WHERE project_id = $2 AND pattern_id = $3',
      [status, req.params.id, req.params.patternId]
    );

    // Return updated pattern info
    const result = await pool.query(
      `SELECT p.*, pp.position, pp.status as project_status, pp.added_at
       FROM patterns p
       JOIN project_patterns pp ON p.id = pp.pattern_id
       WHERE pp.project_id = $1 AND pp.pattern_id = $2`,
      [req.params.id, req.params.patternId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating pattern status in project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get projects that contain a specific pattern
app.get('/api/patterns/:id/projects', async (req, res) => {
  try {
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    const result = await pool.query(
      `SELECT p.*, pp.status as pattern_status, pp.position
       FROM projects p
       JOIN project_patterns pp ON p.id = pp.project_id
       WHERE pp.pattern_id = $1
       AND (p.is_archived = false OR p.is_archived IS NULL)
       ORDER BY p.name`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pattern projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get hashtags for a project
app.get('/api/projects/:id/hashtags', async (req, res) => {
  try {
    const project = await verifyProjectReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to access this project' });
    }

    const result = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN project_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.project_id = $1
       ORDER BY h.name`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching project hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set hashtags for a project
app.put('/api/projects/:id/hashtags', async (req, res) => {
  try {
    const { hashtagIds } = req.body;
    const projectId = req.params.id;

    const project = await verifyProjectOwnership(projectId, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    // Delete existing associations
    await pool.query('DELETE FROM project_hashtags WHERE project_id = $1', [projectId]);

    // Insert new associations
    if (hashtagIds && hashtagIds.length > 0) {
      for (const hashtagId of hashtagIds) {
        await pool.query(
          'INSERT INTO project_hashtags (project_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [projectId, hashtagId]
        );
      }
    }

    // Return updated hashtags
    const result = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN project_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.project_id = $1
       ORDER BY h.name`,
      [projectId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error setting project hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get notes for a project
app.get('/api/projects/:id/notes', async (req, res) => {
  try {
    const project = await verifyProjectReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to access this project' });
    }

    const ownerUsername = project.owner_username || req.user.username;
    const notesDir = getUserProjectNotesDir(ownerUsername);
    const filename = 'project-' + sanitizeNotesFilename(project.name) + '.md';
    const notesPath = path.join(notesDir, filename);

    let notes = '';
    if (fs.existsSync(notesPath)) {
      notes = fs.readFileSync(notesPath, 'utf8');
    }

    res.json({ notes });
  } catch (error) {
    console.error('Error fetching project notes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update notes for a project
app.put('/api/projects/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;

    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    const ownerUsername = project.owner_username || req.user.username;
    const notesDir = getUserProjectNotesDir(ownerUsername);

    // Ensure project notes directory exists
    if (!fs.existsSync(notesDir)) {
      fs.mkdirSync(notesDir, { recursive: true });
    }

    const filename = 'project-' + sanitizeNotesFilename(project.name) + '.md';
    const notesPath = path.join(notesDir, filename);

    if (notes && notes.trim()) {
      fs.writeFileSync(notesPath, notes, 'utf8');
    } else if (fs.existsSync(notesPath)) {
      fs.unlinkSync(notesPath);
    }

    res.json({ notes: notes || '' });
  } catch (error) {
    console.error('Error updating project notes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get project thumbnail (custom if exists, else first pattern's)
app.get('/api/projects/:id/thumbnail', async (req, res) => {
  try {
    const project = await verifyProjectReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to access this project' });
    }

    const ownerUsername = project.owner_username || req.user.username;

    // Check for custom thumbnail first
    if (project.thumbnail) {
      const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), project.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        return res.sendFile(thumbnailPath);
      }
    }

    // Fall back to first pattern's thumbnail
    const firstPattern = await pool.query(
      `SELECT p.thumbnail, p.user_id
       FROM patterns p
       JOIN project_patterns pp ON p.id = pp.pattern_id
       WHERE pp.project_id = $1
       ORDER BY pp.position ASC
       LIMIT 1`,
      [req.params.id]
    );

    if (firstPattern.rows.length > 0 && firstPattern.rows[0].thumbnail) {
      // Get the pattern owner's username
      const patternOwner = await pool.query('SELECT username FROM users WHERE id = $1', [firstPattern.rows[0].user_id]);
      const patternOwnerUsername = patternOwner.rows[0]?.username || ownerUsername;
      const thumbnailPath = path.join(getUserThumbnailsDir(patternOwnerUsername), firstPattern.rows[0].thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        return res.sendFile(thumbnailPath);
      }
    }

    return res.status(404).json({ error: 'Thumbnail not found' });
  } catch (error) {
    console.error('Error fetching project thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload custom thumbnail for a project
app.post('/api/projects/:id/thumbnail', upload.single('thumbnail'), async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ownerUsername = project.owner_username || req.user.username;
    const userThumbnailsDir = getUserThumbnailsDir(ownerUsername);

    // Ensure thumbnail directory exists
    if (!fs.existsSync(userThumbnailsDir)) {
      fs.mkdirSync(userThumbnailsDir, { recursive: true });
    }

    // Delete old thumbnail if exists
    if (project.thumbnail) {
      const oldThumbnailPath = path.join(userThumbnailsDir, project.thumbnail);
      if (fs.existsSync(oldThumbnailPath)) {
        fs.unlinkSync(oldThumbnailPath);
      }
    }

    // Process and save new thumbnail
    const thumbnailFilename = `project-${project.id}-${Date.now()}.jpg`;
    const thumbnailPath = path.join(userThumbnailsDir, thumbnailFilename);

    await sharp(req.file.path)
      .resize(300, 400, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 85 })
      .toFile(thumbnailPath);

    // Clean up temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Update database
    const result = await pool.query(
      'UPDATE projects SET thumbnail = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [thumbnailFilename, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading project thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove custom thumbnail from a project (reverts to auto)
app.delete('/api/projects/:id/thumbnail', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    // Delete thumbnail file if exists
    if (project.thumbnail) {
      const ownerUsername = project.owner_username || req.user.username;
      const thumbnailPath = path.join(getUserThumbnailsDir(ownerUsername), project.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }

    // Update database
    const result = await pool.query(
      'UPDATE projects SET thumbnail = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error removing project thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// Archive a project
app.post('/api/projects/:id/archive', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to archive this project' });
    }

    const result = await pool.query(
      `UPDATE projects
       SET is_archived = true, archived_at = CURRENT_TIMESTAMP, is_current = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    // Delete project notes when archiving
    const ownerUsername = project.owner_username || req.user.username;
    const notesDir = getUserProjectNotesDir(ownerUsername);
    const notesFilename = 'project-' + sanitizeNotesFilename(project.name) + '.md';
    const notesPath = path.join(notesDir, notesFilename);
    if (fs.existsSync(notesPath)) {
      fs.unlinkSync(notesPath);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error archiving project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore a project from archive
app.post('/api/projects/:id/restore', async (req, res) => {
  try {
    const project = await verifyProjectOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!project) {
      return res.status(403).json({ error: 'Not authorized to restore this project' });
    }

    const result = await pool.query(
      `UPDATE projects
       SET is_archived = false, archived_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error restoring project:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================

// Helper to sanitize pattern name for filename
function sanitizeNotesFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100);
}

// Get notes for a pattern
app.get('/api/patterns/:id/notes', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    const userNotesDir = getUserNotesDir(ownerUsername);
    const filename = sanitizeNotesFilename(pattern.name) + '.md';
    const notesPath = path.join(userNotesDir, filename);

    let notes = '';
    if (fs.existsSync(notesPath)) {
      notes = fs.readFileSync(notesPath, 'utf8');
    }

    res.json({ notes });
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update notes for a pattern
app.put('/api/patterns/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    const userNotesDir = getUserNotesDir(ownerUsername);

    // Ensure user notes directory exists
    if (!fs.existsSync(userNotesDir)) {
      fs.mkdirSync(userNotesDir, { recursive: true });
    }

    const filename = sanitizeNotesFilename(pattern.name) + '.md';
    const notesPath = path.join(userNotesDir, filename);

    if (notes && notes.trim()) {
      fs.writeFileSync(notesPath, notes, 'utf8');
    } else if (fs.existsSync(notesPath)) {
      fs.unlinkSync(notesPath);
    }

    res.json({ notes: notes || '' });
  } catch (error) {
    console.error('Error updating notes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle pattern current status
app.patch('/api/patterns/:id/current', async (req, res) => {
  try {
    const { isCurrent } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    // When marking as current, un-complete it (but keep completed_date for history)
    const result = await pool.query(
      `UPDATE patterns
       SET is_current = $1,
           completed = CASE WHEN $1 = true THEN false ELSE completed END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [isCurrent, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating pattern status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle pattern completion status
app.patch('/api/patterns/:id/complete', async (req, res) => {
  try {
    const { completed } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const completedDate = completed ? 'CURRENT_TIMESTAMP' : 'NULL';

    // When marking as complete, remove from current. When marking incomplete, keep current status unchanged
    const result = await pool.query(
      `UPDATE patterns
       SET completed = $1,
           completed_date = ${completedDate},
           is_current = CASE WHEN $1 = true THEN false ELSE is_current END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [completed, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating completion status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle pattern favorite status
app.patch('/api/patterns/:id/favorite', async (req, res) => {
  try {
    const { isFavorite } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET is_favorite = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [isFavorite, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating favorite status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Increment stitch count for a pattern
app.post('/api/patterns/:id/increment-stitch', async (req, res) => {
  try {
    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET stitch_count = stitch_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error incrementing stitch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decrement stitch count for a pattern
app.post('/api/patterns/:id/decrement-stitch', async (req, res) => {
  try {
    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET stitch_count = GREATEST(stitch_count - 1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error decrementing stitch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Increment row count for a pattern
app.post('/api/patterns/:id/increment-row', async (req, res) => {
  try {
    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET row_count = row_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error incrementing row:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decrement row count for a pattern
app.post('/api/patterns/:id/decrement-row', async (req, res) => {
  try {
    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET row_count = GREATEST(row_count - 1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error decrementing row:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset counters for a pattern
app.post('/api/patterns/:id/reset', async (req, res) => {
  try {
    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET stitch_count = 0, row_count = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error resetting counters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update pattern's current page
app.patch('/api/patterns/:id/page', async (req, res) => {
  try {
    const { currentPage } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns SET current_page = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [currentPage, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating page:', error);
    res.status(500).json({ error: error.message });
  }
});

// Counter endpoints

// Get all counters for a pattern
app.get('/api/patterns/:id/counters', async (req, res) => {
  try {
    // Verify read access (owner, admin, or public)
    const pattern = await verifyPatternReadAccess(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to access this pattern' });
    }

    const result = await pool.query(
      'SELECT * FROM counters WHERE pattern_id = $1 ORDER BY position ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching counters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new counter for a pattern
app.post('/api/patterns/:id/counters', async (req, res) => {
  try {
    const { name, value = 0 } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    // Get the max position for this pattern
    const maxPosResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM counters WHERE pattern_id = $1',
      [req.params.id]
    );
    const position = maxPosResult.rows[0].max_pos + 1;

    const result = await pool.query(
      `INSERT INTO counters (pattern_id, name, value, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, name, value, position]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a counter's value
app.patch('/api/counters/:id', async (req, res) => {
  try {
    // Verify ownership through associated pattern
    const counter = await verifyCounterOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!counter) {
      return res.status(403).json({ error: 'Not authorized to modify this counter' });
    }

    const { value, name } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (value !== undefined) {
      updates.push(`value = $${paramCount++}`);
      values.push(value);
    }
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    const query = `
      UPDATE counters
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Counter not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Increment counter
app.post('/api/counters/:id/increment', async (req, res) => {
  try {
    // Verify ownership through associated pattern
    const counter = await verifyCounterOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!counter) {
      return res.status(403).json({ error: 'Not authorized to modify this counter' });
    }

    const result = await pool.query(
      `UPDATE counters
       SET value = value + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error incrementing counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decrement counter
app.post('/api/counters/:id/decrement', async (req, res) => {
  try {
    // Verify ownership through associated pattern
    const counter = await verifyCounterOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!counter) {
      return res.status(403).json({ error: 'Not authorized to modify this counter' });
    }

    const result = await pool.query(
      `UPDATE counters
       SET value = GREATEST(value - 1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error decrementing counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset counter to zero
app.post('/api/counters/:id/reset', async (req, res) => {
  try {
    // Verify ownership through associated pattern
    const counter = await verifyCounterOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!counter) {
      return res.status(403).json({ error: 'Not authorized to modify this counter' });
    }

    const result = await pool.query(
      `UPDATE counters
       SET value = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error resetting counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a counter
app.delete('/api/counters/:id', async (req, res) => {
  try {
    // Verify ownership through associated pattern
    const counter = await verifyCounterOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!counter) {
      return res.status(403).json({ error: 'Not authorized to delete this counter' });
    }

    const result = await pool.query(
      'DELETE FROM counters WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    res.json({ message: 'Counter deleted successfully' });
  } catch (error) {
    console.error('Error deleting counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get library stats (admin sees total, users see their own)
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    const isAdmin = req.user?.role === 'admin';

    // Base condition to exclude archived patterns
    const notArchived = '(is_archived = false OR is_archived IS NULL)';
    // User filter for non-admins
    const userFilter = isAdmin ? '' : ` AND user_id = ${userId}`;

    // Get total patterns count (excluding archived)
    const totalResult = await pool.query(`SELECT COUNT(*) as count FROM patterns WHERE ${notArchived}${userFilter}`);
    const totalPatterns = parseInt(totalResult.rows[0].count);

    // Get current patterns count (excluding archived)
    const currentResult = await pool.query(`SELECT COUNT(*) as count FROM patterns WHERE is_current = true AND ${notArchived}${userFilter}`);
    const currentPatterns = parseInt(currentResult.rows[0].count);

    // Get completed patterns count (excluding archived)
    const completedResult = await pool.query(`SELECT COUNT(*) as count FROM patterns WHERE completed = true AND ${notArchived}${userFilter}`);
    const completedPatterns = parseInt(completedResult.rows[0].count);

    // Get total time spent (excluding archived)
    const timeResult = await pool.query(`SELECT COALESCE(SUM(timer_seconds), 0) as total FROM patterns WHERE ${notArchived}${userFilter}`);
    const totalTimeSeconds = parseInt(timeResult.rows[0].total);

    // Get count of patterns with time logged (excluding archived)
    const patternsWithTimeResult = await pool.query(`SELECT COUNT(*) as count FROM patterns WHERE timer_seconds > 0 AND ${notArchived}${userFilter}`);
    const patternsWithTime = parseInt(patternsWithTimeResult.rows[0].count);

    // Get patterns by category (excluding archived)
    const categoriesResult = await pool.query(
      `SELECT category, COUNT(*) as count FROM patterns WHERE ${notArchived}${userFilter} GROUP BY category ORDER BY count DESC`
    );
    const patternsByCategory = categoriesResult.rows.map(row => ({
      name: row.category,
      count: parseInt(row.count)
    }));

    // Get total rows counted (sum of all counter values from non-archived patterns)
    const userPatternFilter = isAdmin ? '' : ` AND p.user_id = ${userId}`;
    const rowsCountedResult = await pool.query(
      `SELECT COALESCE(SUM(c.value), 0) as total FROM counters c
       JOIN patterns p ON c.pattern_id = p.id
       WHERE ${notArchived.replace(/is_archived/g, 'p.is_archived')}${userPatternFilter}`
    );
    const totalRowsCounted = parseInt(rowsCountedResult.rows[0].total);

    // Calculate total library size from files
    let totalSize = 0;
    if (isAdmin) {
      // Admin: calculate size across all users' patterns
      const patterns = await pool.query(`
        SELECT p.filename, p.category, u.username as owner_username
        FROM patterns p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.is_archived = false OR p.is_archived IS NULL
      `);
      for (const pattern of patterns.rows) {
        const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
        let filePath = path.join(getCategoryDir(ownerUsername, pattern.category), pattern.filename);
        if (!fs.existsSync(filePath)) {
          filePath = path.join(getUserPatternsDir(ownerUsername), pattern.filename);
        }
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          totalSize += stats.size;
        }
      }
    } else {
      // Regular user: calculate size of their patterns only
      const userPatternsDir = getUserPatternsDir(username);
      if (fs.existsSync(userPatternsDir)) {
        const calculateDirSize = (dir) => {
          let size = 0;
          if (fs.existsSync(dir)) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                size += calculateDirSize(fullPath);
              } else {
                size += fs.statSync(fullPath).size;
              }
            }
          }
          return size;
        };
        totalSize = calculateDirSize(userPatternsDir);
      }
    }

    res.json({
      totalPatterns,
      currentPatterns,
      completedPatterns,
      totalTimeSeconds,
      patternsWithTime,
      totalRowsCounted,
      patternsByCategory,
      totalCategories: patternsByCategory.length,
      totalSize,
      libraryPath: isAdmin ? '/opt/yarnl/users' : `/opt/yarnl/users/${username}`,
      backupHostPath: process.env.BACKUP_HOST_PATH || './backups'
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload custom thumbnail for a pattern
app.post('/api/patterns/:id/thumbnail', imageUpload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');

    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';
    const userThumbnailsDir = getUserThumbnailsDir(ownerUsername);

    // Ensure thumbnail directory exists
    if (!fs.existsSync(userThumbnailsDir)) {
      fs.mkdirSync(userThumbnailsDir, { recursive: true });
    }

    // Process uploaded image as thumbnail
    const thumbnailFilename = `thumb-custom-${Date.now()}.jpg`;
    const thumbnailPath = path.join(userThumbnailsDir, thumbnailFilename);

    await sharp(req.file.path)
      .resize(300, 400, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);

    // Delete the uploaded temp file
    fs.unlinkSync(req.file.path);

    // Delete old thumbnail if it exists
    if (pattern.thumbnail) {
      const oldThumbnailPath = path.join(userThumbnailsDir, pattern.thumbnail);
      if (fs.existsSync(oldThumbnailPath)) {
        fs.unlinkSync(oldThumbnailPath);
      }
    }

    // Update database with new thumbnail
    const result = await pool.query(
      `UPDATE patterns
       SET thumbnail = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [thumbnailFilename, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload image for markdown content (returns URL to insert)
app.post('/api/images', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Use current user's images directory
    const username = req.user?.username || process.env.ADMIN_USERNAME || 'admin';
    const imagesDir = getUserImagesDir(username);
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Get pattern name from request body (sent along with the image)
    const patternName = req.body.patternName || 'image';
    // Sanitize pattern name for filename (remove special chars, limit length)
    const safeName = patternName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) || 'image';

    // Generate unique filename with pattern name prefix
    const filename = `${safeName}-${Date.now()}.jpg`;
    const outputPath = path.join(imagesDir, filename);

    // Process and save image (resize if too large, optimize)
    await sharp(req.file.path)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    // Delete temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Return URL for markdown (include username in path)
    const imageUrl = `/api/images/${username}/${filename}`;
    res.json({ url: imageUrl, filename });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to get all text content that might reference images (for a specific user)
async function getAllImageReferences(username) {
  let allContent = '';

  // Get all notes from user's notes directory
  const userNotesDir = getUserNotesDir(username);
  if (fs.existsSync(userNotesDir)) {
    const noteFiles = fs.readdirSync(userNotesDir).filter(f => f.endsWith('.md'));
    for (const file of noteFiles) {
      const content = fs.readFileSync(path.join(userNotesDir, file), 'utf8');
      allContent += content + '\n';
    }
  }

  // Get content from all markdown files in user's patterns directory
  const userPatternsDir = getUserPatternsDir(username);
  if (fs.existsSync(userPatternsDir)) {
    const entries = fs.readdirSync(userPatternsDir).filter(f => {
      const fullPath = path.join(userPatternsDir, f);
      return fs.statSync(fullPath).isDirectory() && f !== 'images' && f !== 'thumbnails';
    });

    for (const category of entries) {
      const categoryPath = path.join(userPatternsDir, category);
      const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(categoryPath, file);
        allContent += '\n' + fs.readFileSync(filePath, 'utf8');
      }
    }
  }

  return allContent;
}

// Get orphaned images count (for UI display) - must be before :filename route
app.get('/api/images/orphaned', async (req, res) => {
  try {
    const username = req.user?.username || process.env.ADMIN_USERNAME || 'admin';
    const imagesDir = getUserImagesDir(username);

    if (!fs.existsSync(imagesDir)) {
      return res.json({ count: 0, files: [] });
    }

    // Get all image files
    const files = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg'));

    // Get all content that might reference images (notes + markdown files)
    const allContent = await getAllImageReferences(username);

    // Find orphaned images and parse pattern name from filename
    const orphaned = files.filter(file => !allContent.includes(file)).map(file => {
      // Filename format: {pattern-slug}-{timestamp}.jpg
      // Extract pattern name by removing timestamp and extension
      const match = file.match(/^(.+)-\d+\.jpg$/);
      const patternSlug = match ? match[1] : 'unknown';
      // Convert slug back to readable name (replace dashes with spaces, title case)
      const patternName = patternSlug
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      return { filename: file, patternName };
    });

    res.json({ count: orphaned.length, files: orphaned });
  } catch (error) {
    console.error('Error checking orphaned images:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get images directory size for backup estimates - must be before :filename route
app.get('/api/images/stats', async (req, res) => {
  try {
    const username = req.user?.username || process.env.ADMIN_USERNAME || 'admin';
    const imagesDir = getUserImagesDir(username);
    let totalSize = 0;
    let count = 0;

    if (fs.existsSync(imagesDir)) {
      const files = fs.readdirSync(imagesDir);
      for (const file of files) {
        const filePath = path.join(imagesDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          totalSize += stat.size;
          count++;
        }
      }
    }

    res.json({ totalSize, count });
  } catch (error) {
    console.error('Error getting images stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get notes directory size for backup estimates
app.get('/api/notes/stats', async (req, res) => {
  try {
    const username = req.user?.username || process.env.ADMIN_USERNAME || 'admin';
    const userNotesDir = getUserNotesDir(username);
    let totalSize = 0;
    let count = 0;

    if (fs.existsSync(userNotesDir)) {
      const files = fs.readdirSync(userNotesDir);
      for (const file of files) {
        const filePath = path.join(userNotesDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          totalSize += stat.size;
          count++;
        }
      }
    }

    res.json({ totalSize, count });
  } catch (error) {
    console.error('Error getting notes stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up orphaned images (images not referenced anywhere)
app.post('/api/images/cleanup', async (req, res) => {
  try {
    const username = req.user?.username || process.env.ADMIN_USERNAME || 'admin';
    const imagesDir = getUserImagesDir(username);

    if (!fs.existsSync(imagesDir)) {
      return res.json({ deleted: [], count: 0 });
    }

    // Get all image files
    const files = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg'));

    // Get all content that might reference images (notes + markdown files)
    const allContent = await getAllImageReferences(username);

    // Find orphaned images (not referenced anywhere)
    const orphaned = files.filter(file => !allContent.includes(file));

    // Delete orphaned files
    for (const file of orphaned) {
      const filePath = path.join(imagesDir, file);
      fs.unlinkSync(filePath);
    }

    res.json({ deleted: orphaned, count: orphaned.length });
  } catch (error) {
    console.error('Error cleaning up images:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve uploaded images - must be LAST of /api/images routes (catches :username/:filename)
app.get('/api/images/:username/:filename', (req, res) => {
  const imagesDir = getUserImagesDir(req.params.username);
  const filePath = path.join(imagesDir, req.params.filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Image not found' });
  }
});

// Update timer for a pattern
app.put('/api/patterns/:id/timer', async (req, res) => {
  try {
    const { timer_seconds } = req.body;

    // Verify ownership before allowing modification
    const pattern = await verifyPatternOwnership(req.params.id, req.user?.id, req.user?.role === 'admin');
    if (!pattern) {
      return res.status(403).json({ error: 'Not authorized to modify this pattern' });
    }

    const result = await pool.query(
      `UPDATE patterns
       SET timer_seconds = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [timer_seconds, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating timer:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BACKUP & RESTORE ENDPOINTS
// ============================================

// Note: Backups are now per-user using getUserBackupsDir(username)

// Default backup settings
const defaultBackupSettings = {
  enabled: false,
  schedule: 'daily',
  time: '03:00',
  includePatterns: true,
  includeMarkdown: true,
  includeArchive: false,
  includeNotes: true,
  pruneEnabled: false,
  pruneMode: 'keep',
  pruneValue: 5,
  lastBackup: null
};

async function loadBackupSettings() {
  try {
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'backup_schedule'"
    );
    if (result.rows.length > 0) {
      return { ...defaultBackupSettings, ...result.rows[0].value };
    }
  } catch (error) {
    console.error('Error loading backup settings:', error);
  }
  return defaultBackupSettings;
}

async function saveBackupSettings(settings) {
  try {
    await pool.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('backup_schedule', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(settings)]);
  } catch (error) {
    console.error('Error saving backup settings:', error);
  }
}

// Create scheduled backup (per-user)
async function createScheduledBackup() {
  const settings = await loadBackupSettings();
  if (!settings.enabled) return;

  const now = new Date();
  const [targetHour, targetMinute] = settings.time.split(':').map(Number);
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Check if we're past the scheduled time today
  const isPastScheduledTime = (currentHour > targetHour) ||
    (currentHour === targetHour && currentMinute >= targetMinute);

  if (!isPastScheduledTime) return;

  // Check if enough time has passed since last backup
  if (settings.lastBackup) {
    const lastDate = new Date(settings.lastBackup);
    const diffMs = now - lastDate;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (settings.schedule === 'daily' && diffDays < 0.9) return;
    if (settings.schedule === 'weekly' && diffDays < 6.9) return;
    if (settings.schedule === 'monthly' && diffDays < 29) return;
  }

  console.log('Running scheduled backup...');

  try {
    const usersResult = await pool.query('SELECT id, username FROM users');
    const timestamp = getLocalTimestamp(now);

    for (const user of usersResult.rows) {
      const { id: userId, username } = user;
      const userBackupsDir = getUserBackupsDir(username);
      const userPatternsDir = getUserPatternsDir(username);
      const userThumbnailsDir = getUserThumbnailsDir(username);
      const userImagesDir = getUserImagesDir(username);
      const userArchiveDir = getUserArchiveDir(username);
      const userNotesDir = getUserNotesDir(username);

      if (!fs.existsSync(userBackupsDir)) {
        fs.mkdirSync(userBackupsDir, { recursive: true });
      }

      const backupFilename = `yarnl-backup-${timestamp}.zip`;
      const backupPath = path.join(userBackupsDir, backupFilename);

      // Export this user's database tables
      const dbExport = {
        exportDate: now.toISOString(),
        version: '2.0',
        username: username,
        includePatterns: settings.includePatterns,
        includeMarkdown: settings.includeMarkdown,
        includeArchive: settings.includeArchive,
        includeNotes: settings.includeNotes,
        tables: {}
      };

      const categoriesResult = await pool.query(
        'SELECT * FROM categories WHERE user_id = $1', [userId]
      );
      dbExport.tables.categories = categoriesResult.rows;

      const hashtagsResult = await pool.query('SELECT * FROM hashtags');
      dbExport.tables.hashtags = hashtagsResult.rows;

      const patternsResult = await pool.query(
        'SELECT * FROM patterns WHERE user_id = $1', [userId]
      );
      dbExport.tables.patterns = patternsResult.rows;

      const patternIds = patternsResult.rows.map(p => p.id);
      if (patternIds.length > 0) {
        const countersResult = await pool.query(
          'SELECT * FROM counters WHERE pattern_id = ANY($1)', [patternIds]
        );
        dbExport.tables.counters = countersResult.rows;

        const patternHashtagsResult = await pool.query(
          'SELECT * FROM pattern_hashtags WHERE pattern_id = ANY($1)', [patternIds]
        );
        dbExport.tables.pattern_hashtags = patternHashtagsResult.rows;
      } else {
        dbExport.tables.counters = [];
        dbExport.tables.pattern_hashtags = [];
      }

      // Create zip archive
      const output = fs.createWriteStream(backupPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      await new Promise((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);
        archive.append(JSON.stringify(dbExport, null, 2), { name: 'database.json' });

        // Add PDF patterns and thumbnails
        if (settings.includePatterns && fs.existsSync(userPatternsDir)) {
          const categories = fs.readdirSync(userPatternsDir).filter(f => {
            const fullPath = path.join(userPatternsDir, f);
            return fs.statSync(fullPath).isDirectory() && f !== 'images' && f !== 'thumbnails';
          });
          for (const category of categories) {
            const categoryPath = path.join(userPatternsDir, category);
            const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.pdf'));
            for (const file of files) {
              archive.file(path.join(categoryPath, file), { name: `patterns/${category}/${file}` });
            }
          }
          if (fs.existsSync(userThumbnailsDir)) {
            archive.directory(userThumbnailsDir, 'patterns/thumbnails');
          }
        }

        // Add markdown patterns
        if (settings.includeMarkdown && fs.existsSync(userPatternsDir)) {
          const categories = fs.readdirSync(userPatternsDir).filter(f => {
            const fullPath = path.join(userPatternsDir, f);
            return fs.statSync(fullPath).isDirectory() && f !== 'images' && f !== 'thumbnails';
          });
          for (const category of categories) {
            const categoryPath = path.join(userPatternsDir, category);
            const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.md'));
            for (const file of files) {
              archive.file(path.join(categoryPath, file), { name: `patterns/${category}/${file}` });
            }
          }
        }

        // Add images when markdown is included
        if (settings.includeMarkdown && fs.existsSync(userImagesDir)) {
          archive.directory(userImagesDir, 'images');
        }

        // Add archive if requested
        if (settings.includeArchive && fs.existsSync(userArchiveDir)) {
          archive.directory(userArchiveDir, 'archive');
        }

        // Add notes if requested
        if (settings.includeNotes && fs.existsSync(userNotesDir)) {
          archive.directory(userNotesDir, 'notes');
        }

        archive.finalize();
      });

      console.log(`Scheduled backup created for ${username}: ${backupFilename}`);

      // Run per-user prune if enabled
      if (settings.pruneEnabled) {
        runScheduledPrune(settings, username);
      }
    }

    // Update last backup time
    settings.lastBackup = now.toISOString();
    await saveBackupSettings(settings);

    // Broadcast backup completion to all connected clients
    broadcastEvent('backup_complete', { filename: `yarnl-backup-${timestamp}.zip` });

    // Send Pushover notification if enabled
    const notifySettings = await loadNotificationSettings();
    if (notifySettings.notifyBackupComplete) {
      await sendPushoverNotification('Yarnl Backup Complete', `Scheduled backup created for ${usersResult.rows.length} user(s)`);
    }
  } catch (error) {
    console.error('Error creating scheduled backup:', error);
    broadcastEvent('backup_error', { error: error.message });

    // Send Pushover notification for error if enabled
    const notifySettings = await loadNotificationSettings();
    if (notifySettings.notifyBackupError) {
      await sendPushoverNotification('Yarnl Backup Failed', `Error: ${error.message}`);
    }
  }
}

function runScheduledPrune(settings, username) {
  try {
    const targetUsername = username || process.env.ADMIN_USERNAME || 'admin';
    const userBackupsDir = getUserBackupsDir(targetUsername);

    if (!fs.existsSync(userBackupsDir)) return;

    const files = fs.readdirSync(userBackupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => ({
        filename: f,
        created: fs.statSync(path.join(userBackupsDir, f)).mtime
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    let toDelete = [];

    if (settings.pruneMode === 'keep') {
      toDelete = files.slice(settings.pruneValue);
    } else if (settings.pruneMode === 'days') {
      // Calculate days from pruneAgeValue and pruneAgeUnit
      let days = settings.pruneAgeValue || 30;
      const unit = settings.pruneAgeUnit || 'days';
      if (unit === 'weeks') days *= 7;
      else if (unit === 'months') days *= 30;
      else if (unit === 'years') days *= 365;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      toDelete = files.filter(f => new Date(f.created) < cutoff);
    }

    for (const f of toDelete) {
      fs.unlinkSync(path.join(userBackupsDir, f.filename));
      console.log(`Pruned old backup: ${f.filename}`);
    }
  } catch (error) {
    console.error('Error pruning backups:', error);
  }
}

// Run backup check every minute
cron.schedule('* * * * *', () => {
  createScheduledBackup();
});

// Get backup schedule settings
app.get('/api/backups/schedule', async (req, res) => {
  try {
    const settings = await loadBackupSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error getting backup settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save backup schedule settings
app.post('/api/backups/schedule', async (req, res) => {
  try {
    const currentSettings = await loadBackupSettings();
    const newSettings = { ...currentSettings, ...req.body };
    await saveBackupSettings(newSettings);
    res.json({ success: true, settings: newSettings });
  } catch (error) {
    console.error('Error saving backup settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
//  NOTIFICATIONS (Pushover)
// ============================================

const defaultNotificationSettings = {
  pushoverEnabled: false,
  pushoverUserKey: '',
  pushoverAppToken: '',
  notifyBackupComplete: true,
  notifyBackupError: true,
  notifyAutoDelete: true
};

async function loadNotificationSettings() {
  try {
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'notifications'"
    );
    if (result.rows.length > 0) {
      return { ...defaultNotificationSettings, ...result.rows[0].value };
    }
  } catch (error) {
    console.error('Error loading notification settings:', error);
  }
  return defaultNotificationSettings;
}

async function saveNotificationSettings(settings) {
  try {
    await pool.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('notifications', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(settings)]);
  } catch (error) {
    console.error('Error saving notification settings:', error);
  }
}

async function sendPushoverNotification(title, message) {
  const settings = await loadNotificationSettings();
  if (!settings.pushoverEnabled || !settings.pushoverUserKey || !settings.pushoverAppToken) {
    return false;
  }

  try {
    const response = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: settings.pushoverAppToken,
        user: settings.pushoverUserKey,
        title: title,
        message: message
      })
    });
    const data = await response.json();
    if (data.status === 1) {
      console.log('Pushover notification sent successfully');
      return true;
    } else {
      console.error('Pushover error:', data.errors);
      return false;
    }
  } catch (error) {
    console.error('Error sending Pushover notification:', error);
    return false;
  }
}

// Get notification settings
app.get('/api/notifications/settings', async (req, res) => {
  try {
    const settings = await loadNotificationSettings();
    // Don't expose tokens in response, just show if they're set
    res.json({
      ...settings,
      pushoverUserKey: settings.pushoverUserKey ? '••••••••' : '',
      pushoverAppToken: settings.pushoverAppToken ? '••••••••' : ''
    });
  } catch (error) {
    console.error('Error getting notification settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save notification settings
app.post('/api/notifications/settings', async (req, res) => {
  try {
    const currentSettings = await loadNotificationSettings();
    const newSettings = { ...currentSettings };

    // Only update fields that are provided
    if (req.body.pushoverEnabled !== undefined) newSettings.pushoverEnabled = req.body.pushoverEnabled;
    if (req.body.pushoverUserKey && req.body.pushoverUserKey !== '••••••••') {
      newSettings.pushoverUserKey = req.body.pushoverUserKey;
    }
    if (req.body.pushoverAppToken && req.body.pushoverAppToken !== '••••••••') {
      newSettings.pushoverAppToken = req.body.pushoverAppToken;
    }
    if (req.body.notifyBackupComplete !== undefined) newSettings.notifyBackupComplete = req.body.notifyBackupComplete;
    if (req.body.notifyBackupError !== undefined) newSettings.notifyBackupError = req.body.notifyBackupError;
    if (req.body.notifyAutoDelete !== undefined) newSettings.notifyAutoDelete = req.body.notifyAutoDelete;

    await saveNotificationSettings(newSettings);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving notification settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test Pushover notification
app.post('/api/notifications/test', async (req, res) => {
  try {
    const success = await sendPushoverNotification('Yarnl Test', 'Pushover notifications are working!');
    if (success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Failed to send notification. Check your credentials.' });
    }
  } catch (error) {
    console.error('Error testing notification:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all backups for current user
app.get('/api/backups', authMiddleware, (req, res) => {
  try {
    const username = req.user.username;
    const userBackupsDir = getUserBackupsDir(username);

    if (!fs.existsSync(userBackupsDir)) {
      return res.json([]);
    }

    const files = fs.readdirSync(userBackupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stats = fs.statSync(path.join(userBackupsDir, f));
        return {
          filename: f,
          size: stats.size,
          created: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(files);
  } catch (error) {
    console.error('Error listing backups:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new backup for current user
app.post('/api/backups', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const userId = req.user.id;
    const userBackupsDir = getUserBackupsDir(username);
    const userPatternsDir = getUserPatternsDir(username);
    const userArchiveDir = getUserArchiveDir(username);
    const userNotesDir = getUserNotesDir(username);
    const userImagesDir = getUserImagesDir(username);
    const userThumbnailsDir = getUserThumbnailsDir(username);

    // Ensure backup directory exists
    if (!fs.existsSync(userBackupsDir)) {
      fs.mkdirSync(userBackupsDir, { recursive: true });
    }

    const {
      clientSettings,
      includePatterns = true,
      includeMarkdown = true,
      includeArchive = false,
      includeNotes = true
    } = req.body;
    const timestamp = getLocalTimestamp();
    const backupFilename = `yarnl-backup-${timestamp}.zip`;
    const backupPath = path.join(userBackupsDir, backupFilename);

    // Export database tables to JSON (only this user's data)
    const dbExport = {
      exportDate: new Date().toISOString(),
      version: '2.0',
      username: username,
      includePatterns,
      includeMarkdown,
      includeArchive,
      includeNotes,
      tables: {}
    };

    // Export user's categories
    const categoriesResult = await pool.query(
      'SELECT * FROM categories WHERE user_id = $1',
      [userId]
    );
    dbExport.tables.categories = categoriesResult.rows;

    // Export hashtags (shared for now)
    const hashtagsResult = await pool.query('SELECT * FROM hashtags');
    dbExport.tables.hashtags = hashtagsResult.rows;

    // Export user's patterns
    const patternsResult = await pool.query(
      'SELECT * FROM patterns WHERE user_id = $1',
      [userId]
    );
    dbExport.tables.patterns = patternsResult.rows;

    // Export counters for user's patterns
    const patternIds = patternsResult.rows.map(p => p.id);
    if (patternIds.length > 0) {
      const countersResult = await pool.query(
        'SELECT * FROM counters WHERE pattern_id = ANY($1)',
        [patternIds]
      );
      dbExport.tables.counters = countersResult.rows;

      const patternHashtagsResult = await pool.query(
        'SELECT * FROM pattern_hashtags WHERE pattern_id = ANY($1)',
        [patternIds]
      );
      dbExport.tables.pattern_hashtags = patternHashtagsResult.rows;
    } else {
      dbExport.tables.counters = [];
      dbExport.tables.pattern_hashtags = [];
    }

    // Create zip archive
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', async () => {
      const stats = fs.statSync(backupPath);
      res.json({
        success: true,
        filename: backupFilename,
        size: stats.size,
        created: new Date().toISOString()
      });

      // Run auto-prune if enabled
      try {
        const scheduleResult = await pool.query(
          "SELECT value FROM settings WHERE key = 'backup_schedule'"
        );
        if (scheduleResult.rows.length > 0) {
          const settings = scheduleResult.rows[0].value;
          if (settings.pruneEnabled) {
            runScheduledPrune(settings, username);
          }
        }
      } catch (pruneError) {
        console.error('Error running auto-prune after manual backup:', pruneError);
      }
    });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(output);

    // Add database export
    archive.append(JSON.stringify(dbExport, null, 2), { name: 'database.json' });

    // Add client settings
    if (clientSettings) {
      archive.append(JSON.stringify(clientSettings, null, 2), { name: 'settings.json' });
    }

    // Add PDF patterns (and thumbnails) only if requested
    if (includePatterns && fs.existsSync(userPatternsDir)) {
      // Add each category directory but only PDF files
      const categories = fs.readdirSync(userPatternsDir).filter(f => {
        const fullPath = path.join(userPatternsDir, f);
        return fs.statSync(fullPath).isDirectory() && f !== 'images' && f !== 'thumbnails';
      });
      for (const category of categories) {
        const categoryPath = path.join(userPatternsDir, category);
        const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.pdf'));
        for (const file of files) {
          archive.file(path.join(categoryPath, file), { name: `patterns/${category}/${file}` });
        }
      }
      // Add thumbnails
      if (fs.existsSync(userThumbnailsDir)) {
        archive.directory(userThumbnailsDir, 'patterns/thumbnails');
      }
    }

    // Add markdown patterns only if requested
    if (includeMarkdown && fs.existsSync(userPatternsDir)) {
      const categories = fs.readdirSync(userPatternsDir).filter(f => {
        const fullPath = path.join(userPatternsDir, f);
        return fs.statSync(fullPath).isDirectory() && f !== 'images' && f !== 'thumbnails';
      });
      for (const category of categories) {
        const categoryPath = path.join(userPatternsDir, category);
        const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.md'));
        for (const file of files) {
          archive.file(path.join(categoryPath, file), { name: `patterns/${category}/${file}` });
        }
      }
    }

    // Add images directory when markdown patterns are included
    if (includeMarkdown && fs.existsSync(userImagesDir)) {
      archive.directory(userImagesDir, 'images');
    }

    // Add archive directory only if requested
    if (includeArchive && fs.existsSync(userArchiveDir)) {
      archive.directory(userArchiveDir, 'archive');
    }

    // Add notes directory only if requested
    if (includeNotes && fs.existsSync(userNotesDir)) {
      archive.directory(userNotesDir, 'notes');
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ error: error.message });
  }
});

// Prune old backups for current user
app.post('/api/backups/prune', authMiddleware, (req, res) => {
  try {
    const username = req.user.username;
    const userBackupsDir = getUserBackupsDir(username);

    if (!fs.existsSync(userBackupsDir)) {
      return res.json({ success: true, deleted: 0 });
    }

    const { mode, value } = req.body;
    const files = fs.readdirSync(userBackupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => ({
        filename: f,
        created: fs.statSync(path.join(userBackupsDir, f)).mtime
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    let deleted = 0;

    if (mode === 'keep') {
      // Keep last X backups
      const keepCount = parseInt(value);
      const toDelete = files.slice(keepCount);
      toDelete.forEach(f => {
        fs.unlinkSync(path.join(userBackupsDir, f.filename));
        deleted++;
      });
    } else if (mode === 'days') {
      // Delete backups older than X days
      const days = parseInt(value);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      files.forEach(f => {
        if (new Date(f.created) < cutoff) {
          fs.unlinkSync(path.join(userBackupsDir, f.filename));
          deleted++;
        }
      });
    }

    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Error pruning backups:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a backup for current user
app.delete('/api/backups/:filename', authMiddleware, (req, res) => {
  try {
    const username = req.user.username;
    const userBackupsDir = getUserBackupsDir(username);

    const filename = req.params.filename;
    // Security: ensure filename is safe
    if (filename.includes('..') || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(userBackupsDir, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    fs.unlinkSync(backupPath);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting backup:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore from backup for current user
app.post('/api/backups/:filename/restore', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const username = req.user.username;
    const userId = req.user.id;
    const userBackupsDir = getUserBackupsDir(username);
    const userPatternsDir = getUserPatternsDir(username);
    const userArchiveDir = getUserArchiveDir(username);
    const userNotesDir = getUserNotesDir(username);
    const userImagesDir = getUserImagesDir(username);

    const filename = req.params.filename;
    // Security: ensure filename is safe
    if (filename.includes('..') || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(userBackupsDir, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Create temp directory for extraction
    const tempDir = path.join(__dirname, 'temp-restore-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    // Extract zip
    await fs.createReadStream(backupPath)
      .pipe(unzipper.Extract({ path: tempDir }))
      .promise();

    // Read database export
    const dbExportPath = path.join(tempDir, 'database.json');
    if (!fs.existsSync(dbExportPath)) {
      throw new Error('Invalid backup: database.json not found');
    }
    const dbExport = JSON.parse(fs.readFileSync(dbExportPath, 'utf8'));

    // Read settings (if present)
    let clientSettings = null;
    const settingsPath = path.join(tempDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      clientSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    // Begin transaction
    await client.query('BEGIN');

    // Clear existing user's data only
    await client.query('DELETE FROM pattern_hashtags WHERE pattern_id IN (SELECT id FROM patterns WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM counters WHERE pattern_id IN (SELECT id FROM patterns WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM patterns WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM categories WHERE user_id = $1', [userId]);

    // Restore user's categories (assign new IDs, associate with current user)
    const categoryIdMap = {};
    for (const row of dbExport.tables.categories || []) {
      const result = await client.query(
        'INSERT INTO categories (name, user_id, position, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [row.name, userId, row.position, row.created_at]
      );
      categoryIdMap[row.id] = result.rows[0].id;
    }

    // Restore user's patterns (assign new IDs, associate with current user)
    const patternIdMap = {};
    for (const row of dbExport.tables.patterns || []) {
      const result = await client.query(
        `INSERT INTO patterns (name, filename, original_name, upload_date, category, description,
         is_current, stitch_count, row_count, created_at, updated_at, thumbnail, current_page,
         completed, completed_date, notes, pattern_type, content, timer_seconds, user_id, last_opened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
        [row.name, row.filename, row.original_name, row.upload_date, row.category, row.description,
         row.is_current, row.stitch_count, row.row_count, row.created_at, row.updated_at, row.thumbnail,
         row.current_page, row.completed, row.completed_date, row.notes, row.pattern_type, row.content, row.timer_seconds, userId, row.last_opened_at || null]
      );
      patternIdMap[row.id] = result.rows[0].id;
    }

    // Restore counters (with mapped pattern IDs)
    for (const row of dbExport.tables.counters || []) {
      const newPatternId = patternIdMap[row.pattern_id];
      if (newPatternId) {
        await client.query(
          'INSERT INTO counters (pattern_id, name, value, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [newPatternId, row.name, row.value, row.position, row.created_at, row.updated_at]
        );
      }
    }

    // Restore pattern_hashtags (with mapped pattern IDs)
    for (const row of dbExport.tables.pattern_hashtags || []) {
      const newPatternId = patternIdMap[row.pattern_id];
      if (newPatternId) {
        await client.query(
          'INSERT INTO pattern_hashtags (pattern_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [newPatternId, row.hashtag_id]
        );
      }
    }

    await client.query('COMMIT');

    // Helper to recursively copy directories
    const copyRecursive = (src, dest) => {
      if (fs.statSync(src).isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
          copyRecursive(path.join(src, child), path.join(dest, child));
        }
      } else {
        fs.copyFileSync(src, dest);
      }
    };

    // Clear and restore user's patterns directory
    const backupPatternsDir = path.join(tempDir, 'patterns');
    if (fs.existsSync(backupPatternsDir)) {
      // Clear existing user patterns directory
      if (fs.existsSync(userPatternsDir)) {
        fs.rmSync(userPatternsDir, { recursive: true });
      }
      fs.mkdirSync(userPatternsDir, { recursive: true });

      // Copy backup patterns to user's patterns directory
      for (const item of fs.readdirSync(backupPatternsDir)) {
        copyRecursive(
          path.join(backupPatternsDir, item),
          path.join(userPatternsDir, item)
        );
      }
    }

    // Clear and restore user's images directory
    const backupImagesDir = path.join(tempDir, 'images');
    if (fs.existsSync(backupImagesDir)) {
      if (fs.existsSync(userImagesDir)) {
        fs.rmSync(userImagesDir, { recursive: true });
      }
      copyRecursive(backupImagesDir, userImagesDir);
    }

    // Clear and restore user's archive directory
    const backupArchiveDir = path.join(tempDir, 'archive');
    if (fs.existsSync(backupArchiveDir)) {
      if (fs.existsSync(userArchiveDir)) {
        fs.rmSync(userArchiveDir, { recursive: true });
      }
      copyRecursive(backupArchiveDir, userArchiveDir);
    }

    // Clear and restore user's notes directory
    const backupNotesDir = path.join(tempDir, 'notes');
    if (fs.existsSync(backupNotesDir)) {
      if (fs.existsSync(userNotesDir)) {
        fs.rmSync(userNotesDir, { recursive: true });
      }
      copyRecursive(backupNotesDir, userNotesDir);
    }

    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true });

    res.json({
      success: true,
      clientSettings,
      message: 'Backup restored successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error restoring backup:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Download a backup file for current user
app.get('/api/backups/:filename/download', authMiddleware, (req, res) => {
  try {
    const username = req.user.username;
    const userBackupsDir = getUserBackupsDir(username);

    const filename = req.params.filename;
    if (filename.includes('..') || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(userBackupsDir, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(backupPath, filename);
  } catch (error) {
    console.error('Error downloading backup:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// ADMIN BACKUP ENDPOINTS
// =====================

// Download admin config backup (OIDC settings + user accounts)
app.get('/api/admin/backup/config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFilename = `yarnl-admin-config-${timestamp}.json`;

    // Get all users (including password hashes for full restore capability)
    const usersResult = await pool.query(
      `SELECT id, username, display_name, role, can_add_patterns, password_required,
              oidc_allowed, oidc_subject, oidc_provider, can_change_username, can_change_password,
              password_hash, created_at, updated_at
       FROM users ORDER BY id`
    );

    // Get OIDC settings
    const oidcResult = await pool.query("SELECT value FROM settings WHERE key = 'oidc'");

    // Get other admin settings
    const backupScheduleResult = await pool.query("SELECT value FROM settings WHERE key = 'backup_schedule'");
    const notifySettingsResult = await pool.query("SELECT value FROM settings WHERE key = 'notify_settings'");
    const archiveSettingsResult = await pool.query("SELECT value FROM settings WHERE key = 'archive_settings'");
    const defaultCategoriesResult = await pool.query("SELECT value FROM settings WHERE key = 'default_categories'");

    const configBackup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      users: usersResult.rows,
      settings: {
        oidc: oidcResult.rows[0]?.value || null,
        backup_schedule: backupScheduleResult.rows[0]?.value || null,
        notify_settings: notifySettingsResult.rows[0]?.value || null,
        archive_settings: archiveSettingsResult.rows[0]?.value || null,
        default_categories: defaultCategoriesResult.rows[0]?.value || null
      }
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename}"`);
    res.send(JSON.stringify(configBackup, null, 2));
  } catch (error) {
    console.error('Error creating admin config backup:', error);
    res.status(500).json({ error: 'Failed to create config backup' });
  }
});

// Restore admin config from backup
app.post('/api/admin/backup/config/restore', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { config, restoreUsers, restoreSettings } = req.body;

    if (!config || !config.version) {
      return res.status(400).json({ error: 'Invalid config backup format' });
    }

    const results = { users: 0, settings: 0 };

    // Restore users
    if (restoreUsers && config.users) {
      for (const user of config.users) {
        // Skip admin user (don't overwrite current admin)
        if (user.role === 'admin' && user.username === process.env.ADMIN_USERNAME) {
          continue;
        }

        // Check if user exists
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [user.username]);

        if (existing.rows.length > 0) {
          // Update existing user
          await pool.query(
            `UPDATE users SET
              display_name = $1, role = $2, can_add_patterns = $3, password_required = $4,
              oidc_allowed = $5, oidc_subject = $6, oidc_provider = $7,
              can_change_username = $8, can_change_password = $9, password_hash = $10,
              updated_at = NOW()
             WHERE username = $11`,
            [user.display_name, user.role, user.can_add_patterns, user.password_required,
             user.oidc_allowed, user.oidc_subject, user.oidc_provider,
             user.can_change_username, user.can_change_password, user.password_hash,
             user.username]
          );
        } else {
          // Insert new user
          await pool.query(
            `INSERT INTO users (username, display_name, role, can_add_patterns, password_required,
              oidc_allowed, oidc_subject, oidc_provider, can_change_username, can_change_password, password_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [user.username, user.display_name, user.role, user.can_add_patterns, user.password_required,
             user.oidc_allowed, user.oidc_subject, user.oidc_provider,
             user.can_change_username, user.can_change_password, user.password_hash]
          );
        }
        results.users++;
      }
    }

    // Restore settings
    if (restoreSettings && config.settings) {
      for (const [key, value] of Object.entries(config.settings)) {
        if (value !== null) {
          await pool.query(
            `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, value]
          );
          results.settings++;
        }
      }
    }

    res.json({ success: true, restored: results });
  } catch (error) {
    console.error('Error restoring admin config:', error);
    res.status(500).json({ error: 'Failed to restore config backup' });
  }
});

// Download all user data backup (files only, not database)
app.get('/api/admin/backup/data', authMiddleware, adminOnly, async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFilename = `yarnl-user-data-${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    // Add all user data directories
    if (fs.existsSync(usersDir)) {
      archive.directory(usersDir, 'users');
    }

    archive.finalize();
  } catch (error) {
    console.error('Error creating user data backup:', error);
    res.status(500).json({ error: 'Failed to create data backup' });
  }
});

// Restore all user data from backup
app.post('/api/admin/backup/data/restore', authMiddleware, adminOnly, async (req, res) => {
  try {
    // This endpoint expects a multipart form with a zip file
    res.status(501).json({ error: 'Use the upload endpoint for data restore' });
  } catch (error) {
    console.error('Error restoring user data:', error);
    res.status(500).json({ error: 'Failed to restore data backup' });
  }
});

// Upload and restore user data backup
const adminDataRestoreUpload = multer({
  dest: path.join(__dirname, 'temp'),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
}).single('backup');

app.post('/api/admin/backup/data/upload', authMiddleware, adminOnly, (req, res) => {
  adminDataRestoreUpload(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: 'Upload failed: ' + err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const tempDir = path.join(__dirname, 'temp', `restore-${Date.now()}`);

    try {
      // Extract the zip file
      fs.mkdirSync(tempDir, { recursive: true });

      await fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: tempDir }))
        .promise();

      // Check for users directory in the backup
      const backupUsersDir = path.join(tempDir, 'users');
      if (!fs.existsSync(backupUsersDir)) {
        throw new Error('Invalid backup: users directory not found');
      }

      // Get list of users in backup
      const backupUsers = fs.readdirSync(backupUsersDir).filter(f =>
        fs.statSync(path.join(backupUsersDir, f)).isDirectory()
      );

      let restoredCount = 0;

      // Restore each user's data
      for (const username of backupUsers) {
        const srcUserDir = path.join(backupUsersDir, username);
        const destUserDir = getUserBaseDir(username);

        // Create user directory if it doesn't exist
        if (!fs.existsSync(destUserDir)) {
          fs.mkdirSync(destUserDir, { recursive: true });
        }

        // Copy all subdirectories (patterns, images, archive, notes, thumbnails, backups)
        const subdirs = fs.readdirSync(srcUserDir).filter(f =>
          fs.statSync(path.join(srcUserDir, f)).isDirectory()
        );

        for (const subdir of subdirs) {
          const srcPath = path.join(srcUserDir, subdir);
          const destPath = path.join(destUserDir, subdir);

          // Ensure destination exists
          if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
          }

          // Copy files recursively
          copyRecursive(srcPath, destPath);
        }

        restoredCount++;
      }

      // Cleanup
      fs.unlinkSync(req.file.path);
      fs.rmSync(tempDir, { recursive: true, force: true });

      res.json({
        success: true,
        message: `Restored data for ${restoredCount} users`,
        users: backupUsers
      });
    } catch (error) {
      // Cleanup on error
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      console.error('Error restoring user data:', error);
      res.status(500).json({ error: 'Failed to restore data: ' + error.message });
    }
  });
});

// Get available mascots
app.get('/api/mascots', (req, res) => {
  try {
    const mascotsDir = path.join(__dirname, 'mascots');
    if (!fs.existsSync(mascotsDir)) {
      return res.json([]);
    }

    // Parse mascot filename to check for .default theme
    const hasDefaultTheme = (filename) => {
      const withoutExt = filename.replace(/\.[^/.]+$/, '');
      const parts = withoutExt.split('.');
      return parts.length >= 2 && parts[parts.length - 1].toLowerCase() === 'default';
    };

    const files = fs.readdirSync(mascotsDir)
      .filter(f => /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f))
      .sort((a, b) => {
        // Mascots with .default theme always first
        const aIsDefault = hasDefaultTheme(a);
        const bIsDefault = hasDefaultTheme(b);
        if (aIsDefault && !bIsDefault) return -1;
        if (!aIsDefault && bIsDefault) return 1;
        // Then alphabetical (case-insensitive)
        return a.toLowerCase().localeCompare(b.toLowerCase());
      })
      .map(f => ({
        filename: f,
        url: `/mascots/${f}`
      }));
    res.json(files);
  } catch (error) {
    console.error('Error listing mascots:', error);
    res.status(500).json({ error: error.message });
  }
});

// Archive auto-delete settings
const defaultArchiveSettings = {
  autoDeleteEnabled: false,
  autoDeleteDays: 30
};

async function loadArchiveSettings() {
  try {
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'archive_settings'"
    );
    if (result.rows.length > 0) {
      return { ...defaultArchiveSettings, ...result.rows[0].value };
    }
  } catch (error) {
    console.error('Error loading archive settings:', error);
  }
  return defaultArchiveSettings;
}

async function saveArchiveSettings(settings) {
  try {
    await pool.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('archive_settings', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(settings)]);
  } catch (error) {
    console.error('Error saving archive settings:', error);
  }
}

// Auto-delete old archived patterns
async function autoDeleteOldArchived() {
  try {
    const settings = await loadArchiveSettings();
    if (!settings.autoDeleteEnabled) return;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - settings.autoDeleteDays);

    // Find archived patterns older than the threshold with owner info
    const result = await pool.query(`
      SELECT p.*, u.username as owner_username
      FROM patterns p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.is_archived = true AND p.archived_at < $1
    `, [daysAgo]);

    if (result.rows.length === 0) return;

    console.log(`Auto-deleting ${result.rows.length} archived patterns older than ${settings.autoDeleteDays} days`);

    for (const pattern of result.rows) {
      const ownerUsername = pattern.owner_username || process.env.ADMIN_USERNAME || 'admin';

      // Delete file from archive
      const archiveFilePath = path.join(getArchiveCategoryDir(ownerUsername, pattern.category), pattern.filename);
      if (fs.existsSync(archiveFilePath)) {
        fs.unlinkSync(archiveFilePath);
      }

      // Delete thumbnail from archive
      if (pattern.thumbnail) {
        const thumbnailPath = path.join(getUserArchiveThumbnailsDir(ownerUsername), pattern.thumbnail);
        if (fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
      }

      // Delete from database
      await pool.query('DELETE FROM patterns WHERE id = $1', [pattern.id]);
    }

    // Clean up empty archive directories
    cleanupEmptyArchiveCategories();

    console.log(`Auto-deleted ${result.rows.length} old archived patterns`);

    // Send notification if enabled
    const notificationSettings = await loadNotificationSettings();
    if (notificationSettings.notifyAutoDelete) {
      const patternNames = result.rows.map(p => p.name).join(', ');
      await sendPushoverNotification(
        'Archive Emptied',
        `${result.rows.length} pattern${result.rows.length !== 1 ? 's' : ''} deleted: ${patternNames}`
      );
    }
  } catch (error) {
    console.error('Error auto-deleting old archived patterns:', error);
  }
}

// Run auto-delete check daily at midnight
cron.schedule('0 0 * * *', () => {
  autoDeleteOldArchived();
});

// Also run on startup (after a delay to ensure DB is ready)
setTimeout(() => {
  autoDeleteOldArchived();
}, 5000);

// Get archive settings
app.get('/api/settings/archive', async (req, res) => {
  try {
    const settings = await loadArchiveSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error getting archive settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save archive settings
app.post('/api/settings/archive', async (req, res) => {
  try {
    const currentSettings = await loadArchiveSettings();
    const newSettings = { ...currentSettings, ...req.body };
    await saveArchiveSettings(newSettings);
    res.json({ success: true, settings: newSettings });
  } catch (error) {
    console.error('Error saving archive settings:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yarnl server running on http://0.0.0.0:${PORT}`);
});
