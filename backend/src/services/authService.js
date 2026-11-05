'use strict';
// Sign-in: scrypt passwords, sessions, lockout, login resolution (local, then Active Directory),
// effective permissions, audit events, and the first-boot administrator (CONTRACT section 14).
// Timestamps here use the real clock on purpose: tests that pin services/time must not expire sessions.
const crypto = require('crypto');
const { getDb } = require('../db');
const { badRequest } = require('../errors');
const permissions = require('./permissions');
const directory = require('./directory');

const IDLE_MS = 12 * 3600 * 1000;
const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const BUMP_MS = 60 * 1000;
const LOCAL_FAILS = 5;
const LOCAL_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_LOCK_MS = 15 * 60 * 1000;
const AD_FAILS = 3;
const AD_WINDOW_MS = 10 * 60 * 1000;
const AD_PAUSE_MS = 10 * 60 * 1000;
const EVENT_KEEP_DAYS = 180;
const SEED_USER = 'admin';
const SEED_PASSWORD = 'M0nkside';

const log = (m) => console.log(`[auth] ${m}`);
const nowMs = () => Date.now();
const iso = (ms) => new Date(ms === undefined ? Date.now() : ms).toISOString();

/* ----------------------------------------------------------------------- */
/* Passwords                                                               */
/* ----------------------------------------------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    const got = crypto.scryptSync(String(pw), salt, want.length, { N, r, p, maxmem: SCRYPT.maxmem });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) {
    return false;
  }
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function checkPasswordRule(pw) {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 128) throw badRequest('Password must be 10 to 128 characters.');
}

/* ----------------------------------------------------------------------- */
/* Audit events                                                            */
/* ----------------------------------------------------------------------- */

function logEvent(e) {
  try {
    getDb().prepare('INSERT INTO auth_events (at, kind, username, user_id, source, ip, detail, actor_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(iso(), e.kind, e.username || null, e.userId || null, e.source || null, e.ip || null, e.detail ? String(e.detail).slice(0, 500) : null, e.actor || null);
  } catch (err) {
    console.warn(`[auth] could not write an audit event: ${err.message}`);
  }
}

/* ----------------------------------------------------------------------- */
/* Roles and effective permissions                                         */
/* ----------------------------------------------------------------------- */

function ensureSystemRoles() {
  const db = getDb();
  const now = iso();
  for (const r of permissions.SYSTEM_ROLES) {
    const row = db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(r.name);
    if (row) {
      db.prepare('UPDATE roles SET system = 1, description = ?, permissions_json = ?, updated_at = ? WHERE id = ?')
        .run(r.description, JSON.stringify(r.permissions), now, row.id);
    } else {
      db.prepare('INSERT INTO roles (name, description, system, permissions_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)')
        .run(r.name, r.description, JSON.stringify(r.permissions), now, now);
    }
  }
}

function parseJson(s, fallback) {
  try { const v = JSON.parse(s); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}

/** One matching rule for role assignments and scope grants (CONTRACT 14.3 step 5, 15.3).
 *  Returns the via label ('direct', 'group:<name>', 'ou:<name>') or null when the row does not reach the user. */
function matchVia(a, user, groups, userDn) {
  if (a.subject_type === 'user') return a.user_id === user.id ? 'direct' : null;
  if (user.source !== 'ad') return null;
  if (a.subject_type === 'ad_group') {
    if ((a.ad_dn && groups.has(a.ad_dn.toLowerCase())) || (a.ad_sid && groups.has(a.ad_sid.toLowerCase()))) return `group:${a.ad_name || a.ad_dn}`;
  } else if (a.subject_type === 'ad_ou') {
    const ou = String(a.ad_dn || '').toLowerCase();
    if (ou && userDn.endsWith(',' + ou)) return `ou:${a.ad_name || a.ad_dn}`;
  }
  return null;
}

/** {permissions: [keys], roles: [{id, name, via}], scope: {all, lob_cg, via}} for a users row. */
function effective(user) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT ra.id, ra.subject_type, ra.user_id, ra.ad_dn, ra.ad_sid, ra.ad_name, r.id AS role_id, r.name, r.permissions_json FROM role_assignments ra JOIN roles r ON r.id = ra.role_id'
  ).all();
  const grants = db.prepare("SELECT subject_type, user_id, ad_dn, ad_sid, ad_name, value FROM scope_grants WHERE dim = 'lob_cg'").all();
  const groups = new Set();
  if (user.source === 'ad') for (const g of parseJson(user.ad_groups_json, [])) groups.add(String(g).toLowerCase());
  const userDn = String(user.ad_dn || '').toLowerCase();
  const perms = new Set();
  const roles = [];
  for (const a of rows) {
    const via = matchVia(a, user, groups, userDn);
    if (!via) continue;
    roles.push({ id: a.role_id, name: a.name, via });
    for (const k of parseJson(a.permissions_json, [])) if (permissions.isKey(k)) perms.add(k);
  }
  const all = perms.has('data.all');
  const via = {};
  if (!all) {
    for (const g of grants) {
      const v = matchVia(g, user, groups, userDn);
      if (!v) continue;
      if (!via[g.value]) via[g.value] = [];
      if (!via[g.value].includes(v)) via[g.value].push(v);
    }
  }
  const scope = { all, lob_cg: Object.keys(via).sort(), via };
  return { permissions: permissions.KEYS.filter((k) => perms.has(k)), roles, scope };
}

function dedupeRoles(roles) {
  const seen = new Set();
  const out = [];
  for (const r of roles) if (!seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, name: r.name }); }
  return out;
}

/* ----------------------------------------------------------------------- */
/* Users                                                                   */
/* ----------------------------------------------------------------------- */

const normName = (s) => String(s === undefined || s === null ? '' : s).trim().toLowerCase();

function userById(id) { return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id); }

function publicUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, email: u.email, source: u.source,
    default_password: u.default_password ? 1 : 0, person_key: u.person_key || null,
    ad_ou: u.ad_ou || null, ad_attrs: parseJson(u.ad_attrs_json, {}),
  };
}

function adInfo() {
  const c = directory.getConfig();
  return { enabled: c.enabled, domain: c.domain };
}

function sessionBody(user, eff) {
  return {
    authenticated: true,
    user: publicUser(user),
    permissions: eff.permissions,
    roles: dedupeRoles(eff.roles),
    scope: { all: eff.scope.all, lob_cg: eff.scope.lob_cg },
    ad: adInfo(),
  };
}

/** Match users.email to people.email (lowercase) in the dataset and store person_key. */
function refreshPersonKeys(db, datasetId, userId) {
  const d = db || getDb();
  let ds = datasetId;
  if (!ds) {
    const a = d.prepare("SELECT id FROM datasets WHERE status = 'active'").get();
    ds = a ? a.id : null;
  }
  const extra = userId ? ' AND id = ?' : '';
  const a = userId ? [userId] : [];
  if (!ds) {
    d.prepare('UPDATE users SET person_key = NULL WHERE person_key IS NOT NULL' + extra).run(...a);
    return;
  }
  d.prepare("UPDATE users SET person_key = (SELECT p.person_key FROM people p WHERE p.dataset_id = ? AND lower(p.email) = lower(users.email) LIMIT 1) WHERE email IS NOT NULL AND email <> ''" + extra).run(ds, ...a);
  d.prepare("UPDATE users SET person_key = NULL WHERE (email IS NULL OR email = '') AND person_key IS NOT NULL" + extra).run(...a);
}

/* ----------------------------------------------------------------------- */
/* Sessions                                                                */
/* ----------------------------------------------------------------------- */

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function createSession(userId, ctx) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = nowMs();
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha(token), userId, iso(now), iso(now), iso(now + ABSOLUTE_MS), (ctx && ctx.ip) || null, ((ctx && ctx.ua) || '').slice(0, 300) || null);
  return token;
}

/** {user, hash} for a cookie token, or null. Expired rows are deleted lazily. */
function resolveSession(token) {
  if (!token) return null;
  const db = getDb();
  const hash = sha(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!s) return null;
  const now = nowMs();
  if (Date.parse(s.expires_at) <= now || Date.parse(s.last_seen_at) + IDLE_MS <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  const user = userById(s.user_id);
  if (!user || !user.active) return null;
  if (now - Date.parse(s.last_seen_at) > BUMP_MS) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(iso(now), hash);
  return { user, hash };
}

function deleteSession(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function dropUserSessions(userId, exceptHash) {
  const db = getDb();
  if (exceptHash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptHash);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function prune() {
  const db = getDb();
  const s = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(iso(), iso(nowMs() - IDLE_MS)).changes;
  const e = db.prepare('DELETE FROM auth_events WHERE at < ?').run(iso(nowMs() - EVENT_KEEP_DAYS * 86400000)).changes;
  return { sessions: s, events: e };
}

/* ----------------------------------------------------------------------- */
/* Login                                                                   */
/* ----------------------------------------------------------------------- */

const adFails = new Map(); // sam -> {times: [ms], pausedUntil}
function resetLockState() { adFails.clear(); }

const BAD = { status: 401, body: { error: 'Wrong username or password', code: 'bad_credentials' } };
const lockedBody = (until) => ({
  error: `Too many failed sign-ins. Try again in ${Math.max(1, Math.ceil((until - nowMs()) / 60000))} minutes.`,
  code: 'locked',
});

function finishLogin(user, eff, ctx) {
  const db = getDb();
  db.prepare('UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(iso(), user.id);
  refreshPersonKeys(db, null, user.id);
  const fresh = userById(user.id);
  const token = createSession(user.id, ctx);
  logEvent({ kind: 'login_ok', username: user.username, userId: user.id, source: user.source, ip: ctx.ip, detail: `roles: ${dedupeRoles(eff.roles).map((r) => r.name).join(', ')}` });
  return { ok: true, status: 200, token, body: sessionBody(fresh, eff) };
}

function localAttempt(user, password, ctx) {
  const db = getDb();
  const now = nowMs();
  if (user.locked_until && Date.parse(user.locked_until) > now) {
    logEvent({ kind: 'login_locked', username: user.username, userId: user.id, source: 'local', ip: ctx.ip, detail: 'sign-in refused while locked' });
    return { ok: false, status: 423, body: lockedBody(Date.parse(user.locked_until)) };
  }
  if (!verifyPassword(password, user.password_hash)) {
    logEvent({ kind: 'login_fail', username: user.username, userId: user.id, source: 'local', ip: ctx.ip, detail: 'wrong password' });
    const since = Math.max(now - LOCAL_WINDOW_MS, user.last_login_at ? Date.parse(user.last_login_at) : 0);
    const count = db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE kind = 'login_fail' AND user_id = ? AND at > ?").get(user.id, iso(since)).n;
    if (count >= LOCAL_FAILS) {
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(count, iso(now + LOCAL_LOCK_MS), user.id);
      logEvent({ kind: 'login_locked', username: user.username, userId: user.id, source: 'local', ip: ctx.ip, detail: `locked for 15 minutes after ${count} failed sign-ins` });
    } else {
      db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(count, user.id);
    }
    return { ok: false, status: BAD.status, body: BAD.body };
  }
  const eff = effective(user);
  if (!eff.permissions.length) {
    logEvent({ kind: 'login_fail', username: user.username, userId: user.id, source: 'local', ip: ctx.ip, detail: 'no role assigned' });
    return { ok: false, status: 403, body: { error: 'This account has no role. Ask an administrator.', code: 'no_role' } };
  }
  return finishLogin(user, eff, ctx);
}

function adRecordFields(rec, groups) {
  const u = rec.user;
  return {
    display_name: u.displayName || u.sam,
    email: u.email || null,
    ad_dn: u.dn,
    ad_sid: u.sid,
    ad_upn: u.upn || null,
    ad_guid: u.guid,
    ad_groups_json: JSON.stringify(groups.flatMap((g) => [g.dn, g.sid].filter(Boolean))),
    ad_ou: u.ou || null,
    ad_attrs_json: JSON.stringify(u.attrs || {}),
  };
}

/** Find a pre-provisioned or earlier AD user row: guid, then sid, then username + source ad. */
function findAdRow(u) {
  const db = getDb();
  let row = null;
  if (u.guid) row = db.prepare("SELECT * FROM users WHERE source = 'ad' AND ad_guid = ?").get(u.guid);
  if (!row && u.sid) row = db.prepare("SELECT * FROM users WHERE source = 'ad' AND ad_sid = ?").get(u.sid);
  if (!row && u.sam) row = db.prepare("SELECT * FROM users WHERE source = 'ad' AND username = ?").get(u.sam.toLowerCase());
  return row || null;
}

function adUsernameFor(u) {
  const sam = u.sam.toLowerCase();
  const clash = getDb().prepare("SELECT 1 FROM users WHERE username = ? AND source <> 'ad'").get(sam);
  if (!clash) return sam;
  return `${(directory.getConfig().domain.split('.')[0] || 'ad')}\\${sam}`;
}

/** Refresh an existing AD row from a directory record. */
function applyAdRecord(row, rec, groups) {
  const f = adRecordFields(rec, groups);
  getDb().prepare(
    'UPDATE users SET display_name = ?, email = ?, ad_dn = ?, ad_sid = ?, ad_upn = ?, ad_guid = ?, ad_groups_json = ?, ad_ou = ?, ad_attrs_json = ?, updated_at = ? WHERE id = ?'
  ).run(f.display_name, f.email, f.ad_dn, f.ad_sid, f.ad_upn, f.ad_guid, f.ad_groups_json, f.ad_ou, f.ad_attrs_json, iso(), row.id);
  return userById(row.id);
}

/** Insert or refresh the AD user for a record (login, pre-provision). Returns {row, created}. */
function upsertAdUser(rec, groups) {
  const existing = findAdRow(rec.user);
  if (existing) return { row: applyAdRecord(existing, rec, groups), created: false };
  const f = adRecordFields(rec, groups);
  const now = iso();
  const info = getDb().prepare(
    "INSERT INTO users (username, display_name, email, source, password_hash, default_password, active, ad_dn, ad_sid, ad_upn, ad_guid, ad_groups_json, ad_ou, ad_attrs_json, created_at, updated_at) VALUES (?, ?, ?, 'ad', NULL, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(adUsernameFor(rec.user), f.display_name, f.email, f.ad_dn, f.ad_sid, f.ad_upn, f.ad_guid, f.ad_groups_json, f.ad_ou, f.ad_attrs_json, now, now);
  return { row: userById(info.lastInsertRowid), created: true };
}

function adPaused(key) {
  const st = adFails.get(key);
  return st && st.pausedUntil && st.pausedUntil > nowMs() ? st.pausedUntil : 0;
}

function adNoteFailure(key) {
  const now = nowMs();
  const st = adFails.get(key) || { times: [], pausedUntil: 0 };
  st.times = st.times.filter((t) => now - t < AD_WINDOW_MS);
  st.times.push(now);
  if (st.times.length >= AD_FAILS) { st.pausedUntil = now + AD_PAUSE_MS; st.times = []; }
  adFails.set(key, st);
}

async function adAttempt(typed, password, ctx) {
  const key = directory.toSam(typed).toLowerCase();
  const pausedUntil = adPaused(key);
  if (pausedUntil) {
    logEvent({ kind: 'login_locked', username: key, source: 'ad', ip: ctx.ip, detail: 'domain sign-ins for this name are paused' });
    return { ok: false, status: 423, body: lockedBody(pausedUntil) };
  }
  let res;
  try {
    res = await directory.authenticate(typed, password);
  } catch (err) {
    logEvent({ kind: 'login_fail', username: key, source: 'ad', ip: ctx.ip, detail: `directory error: ${err.code || 'error'}: ${err.message}` });
    console.warn(`[directory] sign-in for ${key} failed: ${err.code || 'error'}`);
    return { ok: false, status: 503, body: { error: err.message, code: 'ad_unreachable', detail: err.attempts || [] } };
  }
  if (res.status === 'bad_credentials') {
    adNoteFailure(key);
    logEvent({ kind: 'login_fail', username: key, source: 'ad', ip: ctx.ip, detail: 'wrong password or unknown domain user' });
    return { ok: false, status: BAD.status, body: BAD.body };
  }
  if (res.status === 'disabled') {
    logEvent({ kind: 'login_fail', username: key, source: 'ad', ip: ctx.ip, detail: 'account is disabled in Active Directory' });
    return { ok: false, status: 401, body: { error: 'This domain account is disabled.', code: 'ad_disabled' } };
  }
  const { row, created } = upsertAdUser(res, res.groups);
  if (created) logEvent({ kind: 'user_created', username: row.username, userId: row.id, source: 'ad', ip: ctx.ip, detail: 'created at first domain sign-in' });
  if (!row.active) {
    logEvent({ kind: 'login_fail', username: row.username, userId: row.id, source: 'ad', ip: ctx.ip, detail: 'account is disabled here' });
    return { ok: false, status: BAD.status, body: BAD.body };
  }
  adFails.delete(key);
  const eff = effective(row);
  if (!eff.permissions.length) {
    logEvent({ kind: 'login_fail', username: row.username, userId: row.id, source: 'ad', ip: ctx.ip, detail: 'no role reaches this user, their groups or their OU' });
    return {
      ok: false, status: 403,
      body: { error: 'Your domain account signed in but no AIxP role is assigned to you, your groups or your organizational unit. Ask an administrator.', code: 'no_role' },
    };
  }
  return finishLogin(row, eff, ctx);
}

/** Resolve a sign-in. Returns {ok, status, body, token?}; never throws on bad input. */
async function login(rawUsername, password, ctx) {
  const c = ctx || {};
  const name = normName(rawUsername);
  if (!name || typeof password !== 'string' || !password) {
    return { ok: false, status: 400, body: { error: 'Username and password are required', code: 'missing' } };
  }
  const qualified = directory.isDomainQualified(name);
  const adOn = directory.isReady();
  const local = qualified ? null : getDb().prepare("SELECT * FROM users WHERE username = ? AND source = 'local'").get(name);
  if (local && local.active) return localAttempt(local, password, c);
  if (adOn) return adAttempt(name, password, c);
  verifyPassword(password, DUMMY_HASH); // keep the timing close to a real check
  logEvent({ kind: 'login_fail', username: name, userId: local ? local.id : null, source: 'local', ip: c.ip, detail: local ? 'account is disabled' : 'no such user' });
  return { ok: false, status: BAD.status, body: BAD.body };
}

/* ----------------------------------------------------------------------- */
/* Passwords and the first administrator                                   */
/* ----------------------------------------------------------------------- */

function changeOwnPassword(user, current, next, keepHash, ip) {
  if (user.source !== 'local') throw badRequest('Domain passwords are changed in Active Directory, not here.');
  if (!verifyPassword(String(current || ''), user.password_hash)) throw badRequest('The current password is wrong.');
  checkPasswordRule(next);
  getDb().prepare('UPDATE users SET password_hash = ?, default_password = 0, updated_at = ? WHERE id = ?').run(hashPassword(next), iso(), user.id);
  dropUserSessions(user.id, keepHash);
  logEvent({ kind: 'password_change', username: user.username, userId: user.id, source: 'local', ip, detail: 'changed by the user' });
}

function resetPassword(user, next, actorId, ip) {
  checkPasswordRule(next);
  getDb().prepare('UPDATE users SET password_hash = ?, default_password = 0, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .run(hashPassword(next), iso(), user.id);
  dropUserSessions(user.id);
  logEvent({ kind: 'password_reset', username: user.username, userId: user.id, source: 'local', ip, detail: 'reset by an administrator', actor: actorId });
}

/** Seed the system roles, and on an empty users table the admin / M0nkside account. Idempotent. */
function seedAdmin() {
  const db = getDb();
  ensureSystemRoles();
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return false;
  const now = iso();
  const info = db.prepare(
    "INSERT INTO users (username, display_name, source, password_hash, default_password, active, created_at, updated_at) VALUES (?, 'Administrator', 'local', ?, 1, 1, ?, ?)"
  ).run(SEED_USER, hashPassword(SEED_PASSWORD), now, now);
  const role = db.prepare("SELECT id FROM roles WHERE name = 'Administrator' AND system = 1").get();
  db.prepare("INSERT INTO role_assignments (role_id, subject_type, user_id, ad_dn, created_at) VALUES (?, 'user', ?, '', ?)").run(role.id, info.lastInsertRowid, now);
  logEvent({ kind: 'user_created', username: SEED_USER, userId: info.lastInsertRowid, source: 'local', detail: 'initial administrator account' });
  log('seeded the initial administrator account admin (change its password under Settings > Users)');
  return true;
}

module.exports = {
  hashPassword, verifyPassword, checkPasswordRule, logEvent, ensureSystemRoles, effective, dedupeRoles,
  normName, userById, publicUser, sessionBody, adInfo, refreshPersonKeys,
  createSession, resolveSession, deleteSession, dropUserSessions, prune,
  login, applyAdRecord, upsertAdUser, findAdRow, adUsernameFor, changeOwnPassword, resetPassword, seedAdmin, resetLockState, matchVia,
  parseJson, iso, sha,
};
