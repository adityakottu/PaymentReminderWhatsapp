'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { effectivePermissions, ROLES, PERMISSIONS } = require('./permissions');
const { requestContext } = require('../audit/audit');
const { nowIso } = require('../db');

const COOKIE = 'prw_session';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function loadUser(db, id) {
  const user = await db('users').where({ id }).first();
  if (!user || !user.is_active) return null;
  const overrides = await db('user_permissions').where({ user_id: id });
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    permissions: effectivePermissions(user.role, overrides.map((o) => ({ permission: o.permission, granted: !!o.granted }))),
  };
}

async function createUser(db, { username, displayName, password, role, permissions = [] }) {
  if (!ROLES.includes(role)) throw new HttpError(400, `Role must be one of ${ROLES.join(', ')}`);
  if (!username || !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) throw new HttpError(400, 'Invalid username');
  if (!password || password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  const [row] = await db('users')
    .insert({
      username,
      display_name: displayName || username,
      password_hash: await bcrypt.hash(password, 12),
      role,
      is_active: true,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .returning('id');
  const id = typeof row === 'object' ? row.id : row;
  for (const p of permissions) {
    await db('user_permissions').insert({ user_id: id, permission: p, granted: true, created_at: nowIso() });
  }
  return id;
}

function createAuth({ db, config, audit }) {
  const secret = config.auth.jwtSecret;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const ttlMs = config.auth.sessionTtlHours * 3600 * 1000;

  // Very small in-memory brute-force guard (per IP+username).
  const failures = new Map();
  const tooMany = (key) => {
    const f = failures.get(key);
    return f && f.count >= 5 && Date.now() - f.first < 15 * 60 * 1000;
  };

  async function authenticate(req, res, next) {
    try {
      // Browser: HttpOnly cookie. Mobile app: "Authorization: Bearer <token>".
      const bearer = bearerToken(req);
      const token = bearer || (req.cookies && req.cookies[COOKIE]);
      if (!token) throw new HttpError(401, 'Not signed in');
      let payload;
      try {
        payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
      } catch (_) {
        throw new HttpError(401, 'Session expired – please sign in again');
      }
      const user = await loadUser(db, payload.sub);
      if (!user) throw new HttpError(401, 'Account disabled');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  }

  function requirePermission(...perms) {
    return (req, res, next) => {
      if (!req.user) return next(new HttpError(401, 'Not signed in'));
      const missing = perms.filter((p) => !req.user.permissions.has(p));
      if (missing.length) return next(new HttpError(403, 'You do not have permission to perform this action'));
      next();
    };
  }

  // CSRF defence in depth (cookies are also SameSite=Strict): state-changing API
  // calls must carry a custom header, which cross-site forms cannot send.
  function csrfGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Bearer tokens are never sent automatically by a browser, so they cannot be used for CSRF.
    if (bearerToken(req)) return next();
    if (req.get('x-requested-with') !== 'fetch') return next(new HttpError(403, 'Missing X-Requested-With header'));
    next();
  }

  const router = express.Router();

  router.post('/login', express.json({ limit: '10kb' }), async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const key = `${req.ip}|${String(username || '').toLowerCase()}`;
      if (tooMany(key)) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
      const row = username ? await db('users').whereRaw('lower(username) = ?', [String(username).toLowerCase()]).first() : null;
      const ok = row && row.is_active && (await bcrypt.compare(String(password || ''), row.password_hash));
      if (!ok) {
        const f = failures.get(key) || { count: 0, first: Date.now() };
        f.count++;
        failures.set(key, f);
        await audit.log({ action: 'auth.login_failed', description: `Failed sign-in for "${String(username || '').slice(0, 64)}"`, ctx: requestContext(req) });
        throw new HttpError(401, 'Invalid username or password');
      }
      failures.delete(key);
      const user = await loadUser(db, row.id);
      // The mobile app cannot use the browser's same-site cookie, so it receives a bearer token instead.
      const mobile = (req.body || {}).client === 'mobile';
      const tokenTtlMs = mobile ? config.auth.mobileSessionTtlHours * 3600 * 1000 : ttlMs;
      const token = jwt.sign({ sub: row.id, ...(mobile ? { cli: 'mobile' } : {}) }, secret, { algorithm: 'HS256', expiresIn: Math.floor(tokenTtlMs / 1000) });
      await audit.log({ actor: user, action: 'auth.login', description: `${user.username} signed in${mobile ? ' (mobile app)' : ''}`, ctx: requestContext(req) });
      if (mobile) return res.json({ user: serializeUser(user), token, expiresIn: Math.floor(tokenTtlMs / 1000) });
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.auth.cookieSecure,
        maxAge: ttlMs,
        path: '/',
      });
      res.json({ user: serializeUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', authenticate, async (req, res) => {
    await audit.log({ actor: req.user, action: 'auth.logout', description: `${req.user.username} signed out`, ctx: requestContext(req) });
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', authenticate, (req, res) => res.json({ user: serializeUser(req.user) }));

  // --- minimal user administration (admin only) ---
  const users = express.Router();
  users.use(authenticate, requirePermission(PERMISSIONS.MANAGE_USERS));
  users.get('/', async (req, res) => {
    const rows = await db('users').select('id', 'username', 'display_name', 'role', 'is_active').orderBy('id');
    const perms = await db('user_permissions');
    res.json({
      users: rows.map((u) => ({
        ...u,
        is_active: !!u.is_active,
        overrides: perms.filter((p) => p.user_id === u.id).map((p) => ({ permission: p.permission, granted: !!p.granted })),
      })),
    });
  });
  users.post('/', express.json({ limit: '10kb' }), async (req, res, next) => {
    try {
      const { username, displayName, password, role, permissions } = req.body || {};
      const id = await createUser(db, { username, displayName, password, role, permissions: Array.isArray(permissions) ? permissions : [] });
      await audit.log({ actor: req.user, action: 'users.create', description: `Created user ${username} (${role})`, details: { userId: id }, ctx: requestContext(req) });
      res.status(201).json({ id });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) return next(new HttpError(409, 'Username already exists'));
      next(err);
    }
  });
  users.put('/:id/permissions', express.json({ limit: '10kb' }), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { permission, granted } = req.body || {};
      if (!Object.values(PERMISSIONS).includes(permission)) throw new HttpError(400, 'Unknown permission');
      await db('user_permissions').where({ user_id: id, permission }).del();
      if (granted !== null && granted !== undefined) {
        await db('user_permissions').insert({ user_id: id, permission, granted: !!granted, created_at: nowIso() });
      }
      await audit.log({
        actor: req.user,
        action: 'users.permission_changed',
        description: `Set ${permission}=${granted === null || granted === undefined ? 'role default' : !!granted} for user #${id}`,
        ctx: requestContext(req),
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return { router, usersRouter: users, authenticate, requirePermission, csrfGuard };
}

function bearerToken(req) {
  const h = req.get('authorization');
  return h && /^Bearer\s+\S+$/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
}

function serializeUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, permissions: [...u.permissions].sort() };
}

module.exports = { createAuth, createUser, loadUser, HttpError, COOKIE };
