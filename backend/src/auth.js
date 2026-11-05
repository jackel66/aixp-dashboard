'use strict';
// Sign-in gate and /auth routes (CONTRACT section 14). The APP_PASSWORD shared password is gone.
const authService = require('./services/authService');
const permissions = require('./services/permissions');
const { wrap, badRequest } = require('./errors');

const COOKIE = 'aixp_session';
const MAX_AGE = 7 * 24 * 3600;

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

function isSecure(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${isSecure(req) ? '; Secure' : ''}`);
}

function clearCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}

// Enforcement table: first match wins. keys null = open to anyone. A rule with several keys needs all
// of them. Paths are relative to /api. Matching is case-insensitive because Express routes are.
const RULES = [
  { test: (m, p) => (m === 'GET' || m === 'HEAD') && /^\/health\/?$/i.test(p), keys: null },
  { test: (m, p) => /^\/auth(\/|$)/i.test(p), keys: null },
  { test: (m, p) => m === 'GET' && /^\/events\/?$/i.test(p), keys: ['dashboard.view'] },
  { test: (m, p) => /^\/access(\/|$)/i.test(p), keys: ['access.manage'] },
  { test: (m, p) => /^\/settings(\/|$)/i.test(p), keys: ['settings.manage'] },
  { test: (m, p) => m === 'GET' && /^\/datasets\/?$/i.test(p), keys: ['dashboard.view'] },
  { test: (m, p) => m !== 'GET' && m !== 'HEAD' && /^\/datasets(\/|$)/i.test(p), keys: ['data.manage'] },
  { test: (m, p) => /^\/(fixtures|powerbi)(\/|$)/i.test(p), keys: ['data.manage'] },
  { test: (m, p) => /^\/users(\/|$)/i.test(p), keys: ['people.view'] },
  { test: (m, p) => /^\/export\/report\/users_[a-z0-9_]*\.csv$/i.test(p) || /^\/export\/users\.csv$/i.test(p), keys: ['people.view', 'export.csv'] },
  { test: (m, p) => /^\/export(\/|$)/i.test(p), keys: ['export.csv'] },
  { test: (m, p) => /^\/reports\/users_/i.test(p), keys: ['people.view'] },
  { test: (m, p) => /^\/verification\/runs(\/|$)/i.test(p), keys: ['dashboard.view', 'data.all'] },
  { test: () => true, keys: ['dashboard.view'] },
];

function requiredFor(method, path) {
  const m = String(method).toUpperCase();
  for (const r of RULES) if (r.test(m, path)) return r.keys;
  return ['dashboard.view'];
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Gate: runs before every /api route.
function gate(req, res, next) {
  try {
    if (!SAFE.has(req.method) && req.headers['x-aixp-csrf'] !== '1') {
      return res.status(403).json({ error: 'Missing request header', code: 'csrf' });
    }
    const hit = authService.resolveSession(cookieToken(req));
    if (hit) {
      const eff = authService.effective(hit.user);
      req.auth = { user: hit.user, hash: hit.hash, permissions: eff.permissions, roles: eff.roles, scope: eff.scope };
    }
    const keys = requiredFor(req.method, req.path);
    if (keys === null) return next();
    if (!req.auth) return res.status(401).json({ error: 'Sign in required' });
    for (const k of keys) {
      if (!req.auth.permissions.includes(k)) {
        return res.status(403).json({ error: `You do not have permission to ${permissions.verbFor(k)}`, required: k });
      }
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

function routes(router) {
  router.post('/auth/login', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await authService.login(b.username, b.password, { ip: req.ip, ua: req.headers['user-agent'] });
    if (!r.ok) return res.status(r.status).json(r.body);
    setCookie(req, res, r.token);
    return res.json(r.body);
  }));

  router.get('/auth/session', (req, res) => {
    if (!req.auth) return res.json({ authenticated: false, ad: authService.adInfo() });
    const body = authService.sessionBody(req.auth.user, { permissions: req.auth.permissions, roles: req.auth.roles, scope: req.auth.scope });
    return res.json(body);
  });

  router.post('/auth/logout', (req, res) => {
    const token = cookieToken(req);
    if (req.auth) {
      authService.logEvent({ kind: 'logout', username: req.auth.user.username, userId: req.auth.user.id, source: req.auth.user.source, ip: req.ip });
    }
    authService.deleteSession(token);
    clearCookie(req, res);
    res.json({ ok: true });
  });

  router.post('/auth/change-password', wrap((req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Sign in required' });
    const b = req.body || {};
    if (typeof b.new_password !== 'string') throw badRequest('Password must be 10 to 128 characters.');
    authService.changeOwnPassword(req.auth.user, b.current_password, b.new_password, req.auth.hash, req.ip);
    return res.json({ ok: true });
  }));
}

module.exports = { gate, routes, requiredFor, cookieToken, RULES };
