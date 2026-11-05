'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
const authService = require('../src/services/authService');
let app;
let admin;

const PW = 'a-long-password-1';
const roleId = (name) => ctx.db.getDb().prepare('SELECT id FROM roles WHERE name = ?').get(name).id;

async function mkUser(username, roleName, password) {
  const body = { username, display_name: username, password: password || PW, role_ids: roleName ? [roleId(roleName)] : [] };
  // A Viewer has no data.all, so it needs a scope grant to see any figures (CONTRACT 15.1).
  if (roleName === 'Viewer') body.lob_cg = [ctx.db.getDb().prepare("SELECT lob_cg AS v FROM people WHERE lob_cg NOT IN ('', 'Unassigned') LIMIT 1").get().v];
  const r = await admin.call('POST', '/api/access/users', body);
  assert.equal(r.status, 201, r.text);
  return r.json;
}

async function rawLogin(username, password, headers) {
  return fetch(`${app.base}/api/auth/login`, {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-aixp-csrf': '1' }, headers || {}),
    body: JSON.stringify({ username, password }),
  });
}

test.before(async () => {
  seedFixture({ people: 40, months: 2, endDate: '2026-10-30', seed: 4, profile: 'clean' });
  app = await startApp();
  admin = await app.admin();
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

test('first boot seeded admin / M0nkside with the Administrator role and the system roles', () => {
  const db = ctx.db.getDb();
  const u = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.equal(u.source, 'local');
  assert.equal(u.default_password, 1);
  assert.ok(u.password_hash.startsWith('scrypt$16384$8$1$'));
  assert.deepEqual(db.prepare('SELECT name FROM roles WHERE system = 1 ORDER BY id').all().map((r) => r.name), ['Administrator', 'Executive', 'Analyst', 'Viewer']);
  assert.equal(authService.seedAdmin(), false, 'seedAdmin is idempotent');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 1, true);
});

test('login: admin / M0nkside signs in, sets a hardened cookie, session body has every permission', async () => {
  const res = await rawLogin('Admin ', 'M0nkside');
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^aixp_session=[0-9a-f]{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=604800/);
  assert.doesNotMatch(cookie, /Secure/);
  const body = await res.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.user.username, 'admin');
  assert.equal(body.user.default_password, 1);
  assert.deepEqual(body.permissions.slice().sort(), ['access.manage', 'dashboard.view', 'data.all', 'data.manage', 'export.csv', 'people.view', 'settings.manage']);
  assert.deepEqual(body.roles.map((r) => r.name), ['Administrator']);
  assert.deepEqual(body.ad, { enabled: false, domain: '' });
  const secure = await rawLogin('admin', 'M0nkside', { 'x-forwarded-proto': 'https' });
  assert.match(secure.headers.get('set-cookie'), /; Secure/);
});

test('wrong password and unknown user answer the same 401 body', async () => {
  const bad = await app.call('POST', '/api/auth/login', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, { error: 'Wrong username or password', code: 'bad_credentials' });
  const nobody = await app.call('POST', '/api/auth/login', { username: 'nobody', password: 'nope' });
  assert.equal(nobody.status, 401);
  assert.deepEqual(nobody.json, bad.json);
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'admin' })).status, 400);
});

test('csrf: a non-GET without the x-aixp-csrf header is refused, login included', async () => {
  const r = await app.call('POST', '/api/auth/login', { username: 'admin', password: 'M0nkside' }, { noCsrf: true });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: 'Missing request header', code: 'csrf' });
  const r2 = await admin.call('PUT', '/api/settings', { patch: {} }, { noCsrf: true });
  assert.equal(r2.status, 403);
  assert.equal(r2.json.code, 'csrf');
  assert.equal((await admin.call('GET', '/api/summary', undefined, { noCsrf: true })).status, 200);
});

test('no session: 401 on protected routes, health and session stay open', async () => {
  for (const u of ['/api/summary', '/api/settings', '/api/users', '/api/datasets', '/api/export/summary.csv', '/api/access/users', '/api/events']) {
    const r = await app.call('GET', u);
    assert.equal(r.status, 401, u);
    assert.ok(r.json.error);
  }
  assert.equal((await app.call('PUT', '/api/settings', { patch: {} })).status, 401);
  assert.equal((await app.call('GET', '/api/health')).status, 200);
  const s = await app.call('GET', '/api/auth/session');
  assert.equal(s.status, 200);
  assert.equal(s.json.authenticated, false);
  assert.deepEqual(s.json.ad, { enabled: false, domain: '' });
});

test('the cookie works on /api/summary and on the SSE stream; the stream needs a session', async () => {
  const noSession = await fetch(`${app.base}/api/events`);
  assert.equal(noSession.status, 401);
  const res = await fetch(`${app.base}/api/events`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /"type":"hello"/);
  await reader.cancel();
  assert.equal((await admin.call('GET', '/api/summary')).status, 200);
  const s = await admin.call('GET', '/api/auth/session');
  assert.equal(s.json.authenticated, true);
  assert.equal(s.json.user.username, 'admin');
});

test('permissions: Viewer, Executive and Analyst see exactly what their keys allow', async () => {
  await mkUser('vera', 'Viewer');
  await mkUser('eddie', 'Executive');
  await mkUser('anna', 'Analyst');
  const viewer = await app.login('vera', PW);
  const r = await viewer.call('GET', '/api/users');
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: 'You do not have permission to view people', required: 'people.view' });
  assert.equal((await viewer.call('GET', '/api/summary')).status, 200);
  assert.equal((await viewer.call('GET', '/api/datasets')).status, 200);
  assert.equal((await viewer.call('GET', '/api/reports/platforms_monthly')).status, 200);
  const cases = [
    ['GET', '/api/settings', 'settings.manage', 'change settings'],
    ['PUT', '/api/settings', 'settings.manage', 'change settings'],
    ['GET', '/api/access/users', 'access.manage', 'manage access'],
    ['GET', '/api/export/summary.csv', 'export.csv', 'export CSV'],
    ['POST', '/api/datasets/1/verify', 'data.manage', 'manage data'],
    ['POST', '/api/datasets/rollback', 'data.manage', 'manage data'],
    ['POST', '/api/fixtures/generate', 'data.manage', 'manage data'],
    ['GET', '/api/powerbi/status', 'data.manage', 'manage data'],
    ['GET', '/api/reports/users_top', 'people.view', 'view people'],
    ['GET', '/api/users/anything', 'people.view', 'view people'],
  ];
  for (const [m, u, key, verb] of cases) {
    const x = await viewer.call(m, u, m === 'GET' ? undefined : {});
    assert.equal(x.status, 403, `${m} ${u}`);
    assert.deepEqual(x.json, { error: `You do not have permission to ${verb}`, required: key }, `${m} ${u}`);
  }
  const exec = await app.login('eddie', PW);
  assert.equal((await exec.call('GET', '/api/export/summary.csv')).status, 200);
  const eu = await exec.call('GET', '/api/export/users.csv');
  assert.equal(eu.status, 403);
  assert.equal(eu.json.required, 'people.view');
  assert.equal((await exec.call('GET', '/api/export/report/users_top.csv')).json.required, 'people.view');
  const analyst = await app.login('anna', PW);
  assert.equal((await analyst.call('GET', '/api/users')).status, 200);
  assert.equal((await analyst.call('GET', '/api/export/users.csv')).status, 200);
  assert.equal((await analyst.call('GET', '/api/settings')).status, 403);
});

test('path matching is case-insensitive and never falls open', async () => {
  const viewer = await app.login('vera', PW);
  assert.equal((await viewer.call('GET', '/api/Settings')).status, 403);
  assert.equal((await viewer.call('GET', '/api/USERS')).status, 403);
  assert.equal((await viewer.call('GET', '/api/Access/users')).status, 403);
});

test('logout drops the session and clears the cookie', async () => {
  const c = await app.login('vera', PW);
  const out = await c.call('POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await c.call('GET', '/api/summary')).status, 401);
  assert.equal((await c.call('GET', '/api/auth/session')).json.authenticated, false);
});

test('change password: rules, wrong current, drops other sessions but keeps the current one', async () => {
  await mkUser('pat', 'Viewer');
  const a = await app.login('pat', PW);
  const b = await app.login('pat', PW);
  assert.equal((await a.call('POST', '/api/auth/change-password', { current_password: 'wrong-wrong-1', new_password: 'another-long-pw-2' })).status, 400);
  const short = await a.call('POST', '/api/auth/change-password', { current_password: PW, new_password: 'short' });
  assert.equal(short.status, 400);
  assert.equal(short.json.error, 'Password must be 10 to 128 characters.');
  assert.equal((await app.call('POST', '/api/auth/change-password', { current_password: PW, new_password: 'another-long-pw-2' })).status, 401);
  const ok = await a.call('POST', '/api/auth/change-password', { current_password: PW, new_password: 'another-long-pw-2' });
  assert.equal(ok.status, 200);
  assert.equal((await a.call('GET', '/api/summary')).status, 200, 'current session kept');
  assert.equal((await b.call('GET', '/api/summary')).status, 401, 'other session dropped');
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'pat', password: PW })).status, 401);
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'pat', password: 'another-long-pw-2' })).status, 200);
});

test('admin password change clears default_password on the seeded account', async () => {
  const c = await app.login('admin', 'M0nkside');
  assert.equal((await c.call('GET', '/api/auth/session')).json.user.default_password, 1);
  const r = await c.call('POST', '/api/auth/change-password', { current_password: 'M0nkside', new_password: 'M0nkside-changed-9' });
  assert.equal(r.status, 200);
  assert.equal((await c.call('GET', '/api/auth/session')).json.user.default_password, 0);
  // The change dropped the other admin sessions. Put the seed password back and sign in again so
  // the shared admin client keeps working for the later tests.
  ctx.db.getDb().prepare("UPDATE users SET password_hash = ?, default_password = 1 WHERE username = 'admin'").run(authService.hashPassword('M0nkside'));
  admin = await app.login('admin', 'M0nkside');
});

test('lockout: five wrong passwords lock the account for 15 minutes, 423 even with the right one', async () => {
  await mkUser('locky', 'Viewer');
  for (let i = 0; i < 5; i++) assert.equal((await app.call('POST', '/api/auth/login', { username: 'locky', password: 'bad-bad-bad-1' })).status, 401);
  const locked = await app.call('POST', '/api/auth/login', { username: 'locky', password: PW });
  assert.equal(locked.status, 423);
  assert.equal(locked.json.code, 'locked');
  assert.match(locked.json.error, /^Too many failed sign-ins\. Try again in \d+ minutes\.$/);
  const row = ctx.db.getDb().prepare("SELECT failed_logins, locked_until FROM users WHERE username = 'locky'").get();
  assert.equal(row.failed_logins, 5);
  assert.ok(Date.parse(row.locked_until) > Date.now());
  const kinds = ctx.db.getDb().prepare("SELECT kind FROM auth_events WHERE username = 'locky'").all().map((r) => r.kind);
  assert.ok(kinds.includes('login_locked'));
  ctx.db.getDb().prepare("UPDATE users SET locked_until = ? WHERE username = 'locky'").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'locky', password: PW })).status, 200);
  assert.equal(ctx.db.getDb().prepare("SELECT failed_logins FROM users WHERE username = 'locky'").get().failed_logins, 0);
});

test('admin password reset drops the user sessions and sets a new password', async () => {
  const u = await mkUser('rita', 'Viewer');
  const s1 = await app.login('rita', PW);
  const s2 = await app.login('rita', PW);
  assert.equal((await s1.call('GET', '/api/summary')).status, 200);
  const short = await admin.call('PUT', `/api/access/users/${u.id}/password`, { password: 'short' });
  assert.equal(short.status, 400);
  const reset = await admin.call('PUT', `/api/access/users/${u.id}/password`, { password: 'brand-new-password-3' });
  assert.equal(reset.status, 200);
  assert.equal((await s1.call('GET', '/api/summary')).status, 401);
  assert.equal((await s2.call('GET', '/api/summary')).status, 401);
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'rita', password: PW })).status, 401);
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'rita', password: 'brand-new-password-3' })).status, 200);
});

test('sessions expire: 12 hours idle, 7 days absolute; the touch time moves at most once a minute', async () => {
  const c = await app.login('vera', PW);
  const db = ctx.db.getDb();
  const hash = authService.sha(c.cookie.split('=')[1]);
  assert.equal((await c.call('GET', '/api/summary')).status, 200);
  const before = db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hash).last_seen_at;
  assert.equal((await c.call('GET', '/api/summary')).status, 200);
  assert.equal(db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hash).last_seen_at, before, 'not bumped inside a minute');
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 2 * 60000).toISOString(), hash);
  assert.equal((await c.call('GET', '/api/summary')).status, 200);
  assert.notEqual(db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hash).last_seen_at, before);
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 13 * 3600000).toISOString(), hash);
  assert.equal((await c.call('GET', '/api/summary')).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(hash).n, 0, 'expired row deleted');
  const d = await app.login('vera', PW);
  const h2 = authService.sha(d.cookie.split('=')[1]);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1000).toISOString(), h2);
  assert.equal((await d.call('GET', '/api/summary')).status, 401);
});

test('a user with no role cannot sign in; a disabled user gets the plain 401', async () => {
  await mkUser('norole', null);
  const r = await app.call('POST', '/api/auth/login', { username: 'norole', password: PW });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: 'This account has no role. Ask an administrator.', code: 'no_role' });
  const u = await mkUser('gone', 'Viewer');
  const live = await app.login('gone', PW);
  assert.equal((await admin.call('PUT', `/api/access/users/${u.id}`, { active: false })).status, 200);
  assert.equal((await live.call('GET', '/api/summary')).status, 401, 'disabling drops sessions');
  const bad = await app.call('POST', '/api/auth/login', { username: 'gone', password: PW });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'bad_credentials');
});

test('sign-in links the user to the People row with the same email, refreshed again at promote', async () => {
  const db = ctx.db.getDb();
  const p = db.prepare("SELECT person_key, email FROM people WHERE email IS NOT NULL AND email <> '' LIMIT 1").get();
  assert.ok(p, 'fixture has people with email');
  await mkUser('linked', 'Viewer');
  db.prepare("UPDATE users SET email = ? WHERE username = 'linked'").run(p.email.toUpperCase());
  const c = await app.login('linked', PW);
  const s = await c.call('GET', '/api/auth/session');
  assert.equal(s.json.user.person_key, p.person_key);
  db.prepare("UPDATE users SET person_key = NULL WHERE username = 'linked'").run();
  const datasets = require('../src/services/datasets');
  const act = datasets.active();
  authService.refreshPersonKeys(db, act.id);
  assert.equal(db.prepare("SELECT person_key FROM users WHERE username = 'linked'").get().person_key, p.person_key);
  db.prepare("UPDATE users SET email = 'nobody@nowhere.invalid' WHERE username = 'linked'").run();
  authService.refreshPersonKeys(db, act.id);
  assert.equal(db.prepare("SELECT person_key FROM users WHERE username = 'linked'").get().person_key, null);
});

test('scrypt hashes verify, reject a wrong password and are salted', () => {
  const h1 = authService.hashPassword('correct horse battery');
  const h2 = authService.hashPassword('correct horse battery');
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(authService.verifyPassword('correct horse battery', h1), true);
  assert.equal(authService.verifyPassword('correct horse batterz', h1), false);
  assert.equal(authService.verifyPassword('x', 'garbage'), false);
});

test('audit events never carry a password', () => {
  const rows = ctx.db.getDb().prepare('SELECT detail FROM auth_events').all();
  for (const r of rows) {
    assert.doesNotMatch(String(r.detail || ''), new RegExp(`${PW}|M0nkside|brand-new-password|another-long-pw`));
  }
});

test('APP_PASSWORD is ignored now', async () => {
  process.env.APP_PASSWORD = 'legacy';
  try {
    assert.equal((await app.call('GET', '/api/summary')).status, 401);
    assert.equal((await admin.call('GET', '/api/summary')).status, 200);
  } finally { delete process.env.APP_PASSWORD; }
});
