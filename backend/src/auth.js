'use strict';
const crypto = require('crypto');
const { wrap, badRequest, HttpError } = require('./errors');

const sessions = new Set();
const COOKIE = 'aixp_session';

function required() {
  return !!process.env.APP_PASSWORD;
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

function authenticated(req) {
  return !required() || sessions.has(cookieToken(req));
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Gate: every /api route except /api/auth/* and /api/health.
function gate(req, res, next) {
  if (!required()) return next();
  const p = req.path;
  if (p === '/health' || p.startsWith('/auth/')) return next();
  if (authenticated(req)) return next();
  return next(new HttpError(401, 'Sign in required'));
}

function routes(router) {
  router.post('/auth/login', wrap((req, res) => {
    if (!required()) return res.json({ ok: true });
    const pw = req.body && req.body.password;
    if (typeof pw !== 'string') throw badRequest('password is required');
    if (!sameSecret(pw, process.env.APP_PASSWORD)) throw new HttpError(401, 'Wrong password');
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return res.json({ ok: true });
  }));
  router.get('/auth/session', (req, res) => {
    res.json({ required: required(), authenticated: authenticated(req) });
  });
  router.post('/auth/logout', (req, res) => {
    sessions.delete(cookieToken(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
}

module.exports = { gate, routes };
