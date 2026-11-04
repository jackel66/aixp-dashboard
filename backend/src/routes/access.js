'use strict';
// Access management (CONTRACT section 14.4). The gate in auth.js requires access.manage for all of it.
const express = require('express');
const { getDb } = require('../db');
const { badRequest, notFound, conflict, HttpError, wrap } = require('../errors');
const { broadcast } = require('../services/events');
const permissions = require('../services/permissions');
const authService = require('../services/authService');
const directory = require('../services/directory');
const directorySync = require('../services/directorySync');
const settings = require('../services/settings');

const router = express.Router();
const log = (m) => console.log(`[access] ${m}`);
const iso = () => new Date().toISOString();

const EVENT_KINDS = ['login_ok', 'login_fail', 'login_locked', 'logout', 'password_change', 'password_reset', 'user_created',
  'user_updated', 'user_deleted', 'role_created', 'role_updated', 'role_deleted', 'assignment_added', 'assignment_removed',
  'ad_test', 'ad_sync', 'ad_config'];

const actorId = (req) => req.auth.user.id;
const ev = (req, kind, target, detail) => authService.logEvent({
  kind, username: target && target.username, userId: target && target.id, source: target && target.source, ip: req.ip, detail, actor: actorId(req),
});
const changed = (what) => broadcast('access.changed', { what });

function idParam(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${what} id must be a positive integer`);
  return n;
}

function adminRoleId() {
  const r = getDb().prepare("SELECT id FROM roles WHERE name = 'Administrator' AND system = 1").get();
  return r ? r.id : 0;
}

// Active users holding the Administrator role by a direct assignment.
function activeDirectAdmins() {
  return getDb().prepare(
    "SELECT u.id FROM users u JOIN role_assignments ra ON ra.user_id = u.id AND ra.subject_type = 'user' WHERE ra.role_id = ? AND u.active = 1"
  ).all(adminRoleId()).map((r) => r.id);
}

// True when removing this user's administrator standing would leave no active administrator.
function isLastAdmin(userId) {
  const admins = activeDirectAdmins();
  return admins.includes(userId) && admins.length === 1;
}

function userRow(u) {
  const eff = authService.effective(u);
  return {
    id: u.id, username: u.username, display_name: u.display_name, email: u.email, source: u.source, active: u.active ? 1 : 0,
    default_password: u.default_password ? 1 : 0, last_login_at: u.last_login_at, created_at: u.created_at, locked_until: u.locked_until,
    roles: eff.roles, ad_ou: u.ad_ou || null, ad_attrs: authService.parseJson(u.ad_attrs_json, {}), person_key: u.person_key || null,
  };
}

function validRoleIds(ids) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) throw badRequest('role_ids must be an array');
  const out = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || !getDb().prepare('SELECT 1 FROM roles WHERE id = ?').get(id)) throw badRequest(`Unknown role id ${raw}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function setDirectRoles(userId, roleIds) {
  const db = getDb();
  db.prepare("DELETE FROM role_assignments WHERE subject_type = 'user' AND user_id = ?").run(userId);
  const ins = db.prepare("INSERT INTO role_assignments (role_id, subject_type, user_id, ad_dn, created_at) VALUES (?, 'user', ?, '', ?)");
  for (const r of roleIds) ins.run(r, userId, iso());
}

function directRoleIds(userId) {
  return getDb().prepare("SELECT role_id FROM role_assignments WHERE subject_type = 'user' AND user_id = ?").all(userId).map((r) => r.role_id);
}

/* ----------------------------- permissions ------------------------------ */

router.get('/permissions', (req, res) => res.json(permissions.CATALOGUE));

/* -------------------------------- users --------------------------------- */

router.get('/users', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY lower(username)').all();
  res.json({ rows: rows.map(userRow) });
});

router.post('/users', wrap(async (req, res) => {
  const b = req.body || {};
  const username = authService.normName(b.username);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
    throw badRequest('Username must be 1 to 64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit');
  }
  authService.checkPasswordRule(b.password);
  const roleIds = validRoleIds(b.role_ids) || [];
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw conflict(`The username "${username}" is already taken`);
  const display = typeof b.display_name === 'string' && b.display_name.trim() ? b.display_name.trim().slice(0, 120) : username;
  const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim().slice(0, 200) : null;
  const now = iso();
  const hash = authService.hashPassword(b.password);
  let id;
  db.transaction(() => {
    id = db.prepare("INSERT INTO users (username, display_name, email, source, password_hash, default_password, active, created_at, updated_at) VALUES (?, ?, ?, 'local', ?, 0, 1, ?, ?)")
      .run(username, display, email, hash, now, now).lastInsertRowid;
    setDirectRoles(id, roleIds);
  })();
  authService.refreshPersonKeys(db, null, id);
  const u = authService.userById(id);
  ev(req, 'user_created', u, `local user created with ${roleIds.length} role(s)`);
  changed('users');
  res.status(201).json(userRow(u));
}));

function directoryError(res, err) {
  if (err.code === 'NOT_CONFIGURED') return res.status(400).json({ error: err.message, code: 'ad_not_configured' });
  return res.status(503).json({ error: err.message, code: 'ad_unreachable', detail: err.attempts || [] });
}

router.post('/users/ad', wrap(async (req, res) => {
  const dn = req.body && req.body.dn;
  if (typeof dn !== 'string' || !dn.trim()) throw badRequest('dn is required');
  if (!directory.isReady()) throw badRequest('Active Directory is not enabled and configured');
  let rec;
  try { rec = await directory.lookupUser({ dn: dn.trim() }); } catch (err) { return directoryError(res, err); }
  if (!rec) throw notFound('Directory user');
  if (authService.findAdRow(rec.user)) throw conflict('That domain user is already added');
  const { row } = authService.upsertAdUser(rec, rec.groups);
  authService.refreshPersonKeys(getDb(), null, row.id);
  ev(req, 'user_created', row, 'domain user added from a directory search');
  changed('users');
  return res.status(201).json(userRow(authService.userById(row.id)));
}));

router.put('/users/:id', wrap((req, res) => {
  const id = idParam(req.params.id, 'User');
  const db = getDb();
  const u = authService.userById(id);
  if (!u) throw notFound('User');
  const b = req.body || {};
  const roleIds = validRoleIds(b.role_ids);
  let active = u.active;
  if (b.active !== undefined) {
    if (b.active !== true && b.active !== false && b.active !== 0 && b.active !== 1) throw badRequest('active must be true or false');
    active = b.active ? 1 : 0;
  }
  if (active === 0 && u.active === 1) {
    if (id === actorId(req)) throw badRequest('You cannot disable your own account');
    if (isLastAdmin(id)) throw badRequest('The last active administrator cannot be disabled');
  }
  if (roleIds && isLastAdmin(id) && !roleIds.includes(adminRoleId())) {
    throw badRequest('The last active administrator cannot lose the Administrator role');
  }
  const sets = [];
  const args = [];
  if (u.source === 'local') {
    if (b.display_name !== undefined) {
      if (typeof b.display_name !== 'string' || !b.display_name.trim()) throw badRequest('display_name cannot be empty');
      sets.push('display_name = ?'); args.push(b.display_name.trim().slice(0, 120));
    }
    if (b.email !== undefined) {
      if (b.email !== null && typeof b.email !== 'string') throw badRequest('email must be text');
      sets.push('email = ?'); args.push(b.email && b.email.trim() ? b.email.trim().slice(0, 200) : null);
    }
  }
  sets.push('active = ?'); args.push(active);
  sets.push('updated_at = ?'); args.push(iso());
  db.transaction(() => {
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    if (roleIds) setDirectRoles(id, roleIds);
  })();
  if (active === 0) authService.dropUserSessions(id);
  authService.refreshPersonKeys(db, null, id);
  const fresh = authService.userById(id);
  const notes = [];
  if (active !== u.active) notes.push(active ? 'enabled' : 'disabled');
  if (roleIds) notes.push('roles replaced');
  if (b.display_name !== undefined || b.email !== undefined) notes.push('details edited');
  ev(req, 'user_updated', fresh, notes.join(', ') || 'no change');
  changed('users');
  res.json(userRow(fresh));
}));

router.put('/users/:id/password', wrap((req, res) => {
  const id = idParam(req.params.id, 'User');
  const u = authService.userById(id);
  if (!u) throw notFound('User');
  if (u.source !== 'local') throw badRequest('Domain passwords are changed in Active Directory, not here.');
  authService.resetPassword(u, req.body && req.body.password, actorId(req), req.ip);
  changed('users');
  res.json({ ok: true });
}));

router.delete('/users/:id', wrap((req, res) => {
  const id = idParam(req.params.id, 'User');
  const u = authService.userById(id);
  if (!u) throw notFound('User');
  if (id === actorId(req)) throw badRequest('You cannot delete your own account');
  if (isLastAdmin(id)) throw badRequest('The last active administrator cannot be deleted');
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare("DELETE FROM role_assignments WHERE subject_type = 'user' AND user_id = ?").run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  ev(req, 'user_deleted', u, 'user deleted');
  changed('users');
  res.json({ ok: true });
}));

/* -------------------------------- roles --------------------------------- */

function roleShape(r) {
  const db = getDb();
  const count = (type) => db.prepare('SELECT COUNT(*) AS n FROM role_assignments WHERE role_id = ? AND subject_type = ?').get(r.id, type).n;
  return {
    id: r.id, name: r.name, description: r.description || '', system: r.system ? 1 : 0,
    permissions: authService.parseJson(r.permissions_json, []),
    user_count: count('user'), group_count: count('ad_group'), ou_count: count('ad_ou'),
  };
}

function roleFields(b, exceptId) {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 2 || name.length > 60) throw badRequest('Role name must be 2 to 60 characters');
  const dup = getDb().prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(name);
  if (dup && dup.id !== exceptId) throw conflict(`A role named "${name}" already exists`);
  const perms = b.permissions;
  if (!Array.isArray(perms) || !perms.length) throw badRequest('Pick at least one permission');
  for (const k of perms) if (!permissions.isKey(k)) throw badRequest(`Unknown permission "${k}"`);
  const description = b.description === undefined || b.description === null ? '' : String(b.description).trim().slice(0, 300);
  return { name, description, permissions: permissions.KEYS.filter((k) => perms.includes(k)) };
}

router.get('/roles', (req, res) => {
  res.json({ rows: getDb().prepare('SELECT * FROM roles ORDER BY system DESC, (CASE WHEN system = 1 THEN id END), lower(name)').all().map(roleShape) });
});

router.post('/roles', wrap((req, res) => {
  const f = roleFields(req.body || {}, 0);
  const now = iso();
  const id = getDb().prepare('INSERT INTO roles (name, description, system, permissions_json, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
    .run(f.name, f.description, JSON.stringify(f.permissions), now, now).lastInsertRowid;
  ev(req, 'role_created', null, `role "${f.name}": ${f.permissions.join(', ')}`);
  changed('roles');
  res.status(201).json(roleShape(getDb().prepare('SELECT * FROM roles WHERE id = ?').get(id)));
}));

function roleOr404(req) {
  const id = idParam(req.params.id, 'Role');
  const r = getDb().prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!r) throw notFound('Role');
  return r;
}

router.put('/roles/:id', wrap((req, res) => {
  const r = roleOr404(req);
  if (r.system) throw badRequest('System roles cannot be edited');
  const f = roleFields(req.body || {}, r.id);
  getDb().prepare('UPDATE roles SET name = ?, description = ?, permissions_json = ?, updated_at = ? WHERE id = ?')
    .run(f.name, f.description, JSON.stringify(f.permissions), iso(), r.id);
  ev(req, 'role_updated', null, `role "${f.name}": ${f.permissions.join(', ')}`);
  changed('roles');
  res.json(roleShape(getDb().prepare('SELECT * FROM roles WHERE id = ?').get(r.id)));
}));

router.delete('/roles/:id', wrap((req, res) => {
  const r = roleOr404(req);
  if (r.system) throw badRequest('System roles cannot be deleted');
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM role_assignments WHERE role_id = ?').run(r.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
  })();
  ev(req, 'role_deleted', null, `role "${r.name}" deleted`);
  changed('roles');
  res.json({ ok: true });
}));

/* ----------------------------- assignments ------------------------------ */

function assignmentShape(a) {
  let user = null;
  if (a.subject_type === 'user') {
    const u = authService.userById(a.user_id);
    user = u ? { id: u.id, username: u.username, display_name: u.display_name, source: u.source } : null;
  }
  return {
    id: a.id, subject_type: a.subject_type, user, ad_dn: a.ad_dn || null, ad_sid: a.ad_sid || null, ad_name: a.ad_name || null, created_at: a.created_at,
  };
}

router.get('/roles/:id/assignments', wrap((req, res) => {
  const r = roleOr404(req);
  const rows = getDb().prepare('SELECT * FROM role_assignments WHERE role_id = ? ORDER BY id').all(r.id);
  res.json({ rows: rows.map(assignmentShape) });
}));

router.post('/roles/:id/assignments', wrap((req, res) => {
  const r = roleOr404(req);
  const b = req.body || {};
  const db = getDb();
  let row;
  if (b.subject_type === 'user') {
    const uid = Number(b.user_id);
    if (!Number.isInteger(uid) || !authService.userById(uid)) throw badRequest('Unknown user');
    if (db.prepare("SELECT 1 FROM role_assignments WHERE role_id = ? AND subject_type = 'user' AND user_id = ?").get(r.id, uid)) {
      throw conflict('That user already has this role');
    }
    const id = db.prepare("INSERT INTO role_assignments (role_id, subject_type, user_id, ad_dn, created_at) VALUES (?, 'user', ?, '', ?)").run(r.id, uid, iso()).lastInsertRowid;
    row = db.prepare('SELECT * FROM role_assignments WHERE id = ?').get(id);
  } else if (b.subject_type === 'ad_group' || b.subject_type === 'ad_ou') {
    if (!directory.isEnabled()) throw badRequest('Active Directory is not enabled');
    if (typeof b.ad_dn !== 'string' || !b.ad_dn.trim()) throw badRequest('ad_dn is required');
    const dn = b.ad_dn.trim();
    if (db.prepare('SELECT 1 FROM role_assignments WHERE role_id = ? AND subject_type = ? AND lower(ad_dn) = lower(?)').get(r.id, b.subject_type, dn)) {
      throw conflict('That directory entry already has this role');
    }
    const sid = b.subject_type === 'ad_group' && typeof b.ad_sid === 'string' && b.ad_sid.trim() ? b.ad_sid.trim() : null;
    const name = typeof b.ad_name === 'string' && b.ad_name.trim() ? b.ad_name.trim().slice(0, 200) : dn;
    const id = db.prepare('INSERT INTO role_assignments (role_id, subject_type, user_id, ad_dn, ad_sid, ad_name, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(r.id, b.subject_type, dn, sid, name, iso()).lastInsertRowid;
    row = db.prepare('SELECT * FROM role_assignments WHERE id = ?').get(id);
  } else {
    throw badRequest("subject_type must be 'user', 'ad_group' or 'ad_ou'");
  }
  ev(req, 'assignment_added', null, `role "${r.name}" -> ${row.subject_type} ${row.subject_type === 'user' ? (authService.userById(row.user_id) || {}).username : row.ad_name}`);
  changed('assignments');
  res.status(201).json(assignmentShape(row));
}));

router.delete('/roles/:id/assignments/:aid', wrap((req, res) => {
  const r = roleOr404(req);
  const aid = idParam(req.params.aid, 'Assignment');
  const db = getDb();
  const a = db.prepare('SELECT * FROM role_assignments WHERE id = ? AND role_id = ?').get(aid, r.id);
  if (!a) throw notFound('Assignment');
  if (a.subject_type === 'user' && r.id === adminRoleId() && isLastAdmin(a.user_id)) {
    throw badRequest('The last active administrator cannot lose the Administrator role');
  }
  db.prepare('DELETE FROM role_assignments WHERE id = ?').run(aid);
  ev(req, 'assignment_removed', null, `role "${r.name}" <- ${a.subject_type} ${a.subject_type === 'user' ? (authService.userById(a.user_id) || {}).username : a.ad_name}`);
  changed('assignments');
  res.json({ ok: true });
}));

/* ------------------------------ directory ------------------------------- */

function directoryBody() {
  const cfg = {};
  for (const k of ['ad.enabled', 'ad.domain', 'ad.bind_user', 'ad.servers', 'ad.base_dn', 'ad.tls_mode', 'ad.tls_verify', 'ad.ca_cert', 'ad.sync_minutes', 'ad.deactivate_removed']) {
    cfg[k] = settings.get(k);
  }
  cfg['ad.bind_password'] = { set: !!settings.getSecret('ad.bind_password') };
  const st = settings.get('ad.status', null) || {};
  return {
    config: cfg,
    discovered: settings.get('ad.discovered', null) || { servers: [], base_dn: '', url: '', at: null, error: null },
    status: {
      last_test_at: st.last_test_at || null, last_test_ok: st.last_test_ok === undefined ? null : st.last_test_ok, last_test: st.last_test || { ok: null, duration_ms: 0, steps: [] },
      last_sync_at: st.last_sync_at || null, last_sync: st.last_sync || { users: 0, updated: 0, deactivated: 0, errors: [] },
    },
    user_count: getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE source = 'ad'").get().n,
  };
}

router.get('/directory', (req, res) => res.json(directoryBody()));

router.put('/directory', wrap((req, res) => {
  const body = req.body || {};
  const patch = body.patch === undefined ? body : body.patch;
  const keys = settings.updateAd(patch);
  if (keys.length) {
    ev(req, 'ad_config', null, `changed: ${keys.join(', ')}`);
    changed('directory');
  }
  // Discovery runs in the background; the answer does not wait for it.
  directory.runDiscovery().then(() => changed('directory')).catch((e) => console.warn(`[directory] discovery failed: ${e.message}`));
  res.json(directoryBody());
}));

router.post('/directory/test', wrap(async (req, res) => {
  let result;
  try {
    result = await directory.testChecklist();
  } catch (err) {
    result = { ok: false, duration_ms: 0, steps: [{ key: 'dns', ok: false, label: 'Find domain controllers', detail: err.message }] };
  }
  ev(req, 'ad_test', null, result.ok ? 'all steps passed' : `failed at ${(result.steps.find((s) => !s.ok) || {}).key}`);
  changed('directory');
  res.json(result);
}));

router.get('/directory/search', wrap(async (req, res) => {
  if (!directory.isEnabled()) throw badRequest('Active Directory is not enabled');
  const types = String(req.query.type || 'user').split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of types) if (!['user', 'group', 'ou'].includes(t)) throw badRequest("type must be user, group or ou (comma separated)");
  try {
    const rows = await directory.search(types, req.query.q);
    return res.json({ rows });
  } catch (err) {
    return directoryError(res, err);
  }
}));

router.post('/directory/sync', wrap(async (req, res) => {
  if (!directory.isEnabled()) throw badRequest('Active Directory is not enabled');
  const out = await directorySync.runSync({ manual: true, actor: actorId(req) });
  changed('users');
  res.json(out);
}));

/* -------------------------------- events -------------------------------- */

router.get('/events', wrap((req, res) => {
  let limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest('limit must be a positive integer');
  limit = Math.min(limit, 1000);
  const kind = req.query.kind;
  if (kind !== undefined && kind !== '' && !EVENT_KINDS.includes(kind)) throw badRequest('Unknown kind');
  const rows = kind
    ? getDb().prepare('SELECT * FROM auth_events WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit)
    : getDb().prepare('SELECT * FROM auth_events ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ rows });
}));

module.exports = router;
