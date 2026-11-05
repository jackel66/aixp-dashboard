'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
let app;
let admin;
const PW = 'a-long-password-1';
const roleByName = (n) => ctx.db.getDb().prepare('SELECT * FROM roles WHERE name = ?').get(n);

test.before(async () => {
  seedFixture({ people: 20, months: 2, endDate: '2026-10-30', seed: 4, profile: 'clean' });
  app = await startApp();
  admin = await app.admin();
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

test('permission catalogue lists the seven keys with labels and descriptions', async () => {
  const r = await admin.call('GET', '/api/access/permissions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((p) => p.key), ['dashboard.view', 'people.view', 'export.csv', 'data.manage', 'settings.manage', 'access.manage', 'data.all']);
  for (const p of r.json) { assert.ok(p.label); assert.ok(p.description); }
});

test('system roles are listed with counts and cannot be edited or deleted', async () => {
  const r = await admin.call('GET', '/api/access/roles');
  assert.equal(r.status, 200);
  const names = r.json.rows.map((x) => x.name);
  assert.deepEqual(names.slice(0, 4), ['Administrator', 'Executive', 'Analyst', 'Viewer']);
  const a = r.json.rows.find((x) => x.name === 'Administrator');
  assert.equal(a.system, 1);
  assert.equal(a.permissions.length, 7);
  assert.equal(a.user_count, 1);
  assert.equal(a.group_count, 0);
  assert.equal(a.ou_count, 0);
  const put = await admin.call('PUT', `/api/access/roles/${a.id}`, { name: 'Boss', description: '', permissions: ['dashboard.view'] });
  assert.equal(put.status, 400);
  assert.equal(put.json.error, 'System roles cannot be edited');
  assert.equal((await admin.call('DELETE', `/api/access/roles/${a.id}`)).status, 400);
});

test('role CRUD: validation, unique name (case-insensitive), edit, delete removes assignments', async () => {
  const bad = [
    [{ name: 'x', permissions: ['dashboard.view'] }, /2 to 60/],
    [{ name: 'Okay name', permissions: [] }, /at least one/],
    [{ name: 'Okay name', permissions: ['nope.key'] }, /Unknown permission/],
    [{ name: 'Okay name' }, /at least one/],
  ];
  for (const [body, re] of bad) {
    const r = await admin.call('POST', '/api/access/roles', body);
    assert.equal(r.status, 400);
    assert.match(r.json.error, re);
  }
  const mk = await admin.call('POST', '/api/access/roles', { name: 'Finance review', description: 'Finance team', permissions: ['export.csv', 'dashboard.view'] });
  assert.equal(mk.status, 201);
  assert.equal(mk.json.system, 0);
  assert.deepEqual(mk.json.permissions, ['dashboard.view', 'export.csv']);
  assert.equal((await admin.call('POST', '/api/access/roles', { name: 'FINANCE REVIEW', permissions: ['dashboard.view'] })).status, 409);
  assert.equal((await admin.call('POST', '/api/access/roles', { name: 'viewer', permissions: ['dashboard.view'] })).status, 409);
  const upd = await admin.call('PUT', `/api/access/roles/${mk.json.id}`, { name: 'Finance read', description: '', permissions: ['dashboard.view', 'people.view'] });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.name, 'Finance read');
  assert.deepEqual(upd.json.permissions, ['dashboard.view', 'people.view']);
  const u = await admin.call('POST', '/api/access/users', { username: 'fin', password: PW, role_ids: [mk.json.id] });
  assert.equal(u.status, 201);
  assert.equal((await admin.call('GET', '/api/access/roles')).json.rows.find((r) => r.id === mk.json.id).user_count, 1);
  const del = await admin.call('DELETE', `/api/access/roles/${mk.json.id}`);
  assert.equal(del.status, 200);
  assert.equal(ctx.db.getDb().prepare('SELECT COUNT(*) AS n FROM role_assignments WHERE role_id = ?').get(mk.json.id).n, 0);
  assert.equal((await admin.call('DELETE', `/api/access/roles/${mk.json.id}`)).status, 404);
  // the user now has no role, so they cannot sign in
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'fin', password: PW })).json.code, 'no_role');
});

test('user creation: validation, 409 on a taken name, roles become direct assignments', async () => {
  assert.equal((await admin.call('POST', '/api/access/users', { username: 'Bad Name', password: PW })).status, 400);
  assert.equal((await admin.call('POST', '/api/access/users', { username: 'a@b', password: PW })).status, 400);
  assert.equal((await admin.call('POST', '/api/access/users', { username: 'okname', password: 'short' })).status, 400);
  assert.equal((await admin.call('POST', '/api/access/users', { username: 'okname', password: PW, role_ids: [99999] })).status, 400);
  const viewer = roleByName('Viewer');
  const r = await admin.call('POST', '/api/access/users', { username: ' Carol ', display_name: 'Carol C', email: 'carol@example.com', password: PW, role_ids: [viewer.id] });
  assert.equal(r.status, 201);
  assert.equal(r.json.username, 'carol');
  assert.equal(r.json.source, 'local');
  assert.deepEqual(r.json.roles, [{ id: viewer.id, name: 'Viewer', via: 'direct' }]);
  assert.equal((await admin.call('POST', '/api/access/users', { username: 'CAROL', password: PW })).status, 409);
  const list = await admin.call('GET', '/api/access/users');
  const row = list.json.rows.find((x) => x.username === 'carol');
  for (const k of ['id', 'username', 'display_name', 'email', 'source', 'active', 'default_password', 'last_login_at', 'created_at', 'locked_until', 'roles', 'ad_ou', 'ad_attrs', 'person_key']) {
    assert.ok(k in row, `row has ${k}`);
  }
  assert.equal(row.active, 1);
  assert.equal(list.json.rows.find((x) => x.username === 'admin').default_password, 1);
  assert.equal(JSON.stringify(list.json).includes('password_hash'), false);
});

test('user edit: details, role replacement, disable drops sessions, enable restores', async () => {
  const analyst = roleByName('Analyst');
  const viewer = roleByName('Viewer');
  const c = await admin.call('POST', '/api/access/users', { username: 'dave', password: PW, role_ids: [viewer.id] });
  const sess = await app.login('dave', PW);
  assert.equal((await sess.call('GET', '/api/users')).status, 403);
  const e = await admin.call('PUT', `/api/access/users/${c.json.id}`, { display_name: 'Dave D', email: 'dave@example.com', role_ids: [analyst.id] });
  assert.equal(e.status, 200);
  assert.equal(e.json.display_name, 'Dave D');
  assert.deepEqual(e.json.roles.map((r) => r.name), ['Analyst']);
  assert.equal((await sess.call('GET', '/api/users?pageSize=5')).status, 200, 'new role applies to the live session');
  assert.equal((await admin.call('PUT', `/api/access/users/${c.json.id}`, { active: 'maybe' })).status, 400);
  const off = await admin.call('PUT', `/api/access/users/${c.json.id}`, { active: false });
  assert.equal(off.json.active, 0);
  assert.equal((await sess.call('GET', '/api/summary')).status, 401);
  await admin.call('PUT', `/api/access/users/${c.json.id}`, { active: true });
  assert.equal((await app.call('POST', '/api/auth/login', { username: 'dave', password: PW })).status, 200);
  assert.equal((await admin.call('PUT', '/api/access/users/99999', { active: true })).status, 404);
});

test('guards: no self-disable, no self-delete, the last active administrator stays', async () => {
  const me = ctx.db.getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const off = await admin.call('PUT', `/api/access/users/${me}`, { active: false });
  assert.equal(off.status, 400);
  assert.match(off.json.error, /your own account/);
  assert.equal((await admin.call('DELETE', `/api/access/users/${me}`)).status, 400);
  // a second administrator exists: the first can be disabled by the second, but not the last one
  const adminRole = roleByName('Administrator');
  const two = await admin.call('POST', '/api/access/users', { username: 'admin2', password: PW, role_ids: [adminRole.id] });
  const second = await app.login('admin2', PW);
  const dis = await second.call('PUT', `/api/access/users/${me}`, { active: false });
  assert.equal(dis.status, 200);
  assert.equal((await admin.call('GET', '/api/summary')).status, 401, 'the disabled admin lost the session');
  const last = await second.call('PUT', `/api/access/users/${me}`, { active: true });
  assert.equal(last.status, 200);
  // now disable admin2 from admin (two admins: allowed), then admin is the last
  admin = await app.login('admin', 'M0nkside');
  assert.equal((await admin.call('PUT', `/api/access/users/${two.json.id}`, { active: false })).status, 200);
  const lastGuard = await admin.call('PUT', `/api/access/users/${me}`, { role_ids: [] });
  assert.equal(lastGuard.status, 400);
  assert.match(lastGuard.json.error, /last active administrator/);
  // a second active admin can be deleted, the last cannot
  await admin.call('PUT', `/api/access/users/${two.json.id}`, { active: true });
  const second2 = await app.login('admin2', PW);
  const delMe = await second2.call('DELETE', `/api/access/users/${me}`);
  assert.equal(delMe.status, 200);
  assert.equal((await second2.call('DELETE', `/api/access/users/${two.json.id}`)).status, 400, 'self delete');
  // restore a working admin for the remaining tests: the seed account is gone, admin2 takes over
  admin = second2;
  const asn = await admin.call('GET', `/api/access/roles/${adminRole.id}/assignments`);
  assert.equal(asn.json.rows.length, 1);
  const remove = await admin.call('DELETE', `/api/access/roles/${adminRole.id}/assignments/${asn.json.rows[0].id}`);
  assert.equal(remove.status, 400, 'removing the last administrator assignment is refused');
});

test('assignments: user subject, duplicates, validation, AD subjects need Active Directory on', async () => {
  const mk = await admin.call('POST', '/api/access/roles', { name: 'Auditors', permissions: ['dashboard.view', 'export.csv'] });
  const rid = mk.json.id;
  const u = await admin.call('POST', '/api/access/users', { username: 'erin', password: PW });
  const add = await admin.call('POST', `/api/access/roles/${rid}/assignments`, { subject_type: 'user', user_id: u.json.id });
  assert.equal(add.status, 201);
  assert.equal(add.json.subject_type, 'user');
  assert.equal(add.json.user.username, 'erin');
  assert.equal((await admin.call('POST', `/api/access/roles/${rid}/assignments`, { subject_type: 'user', user_id: u.json.id })).status, 409);
  assert.equal((await admin.call('POST', `/api/access/roles/${rid}/assignments`, { subject_type: 'user', user_id: 99999 })).status, 400);
  assert.equal((await admin.call('POST', `/api/access/roles/${rid}/assignments`, { subject_type: 'team' })).status, 400);
  const ad = await admin.call('POST', `/api/access/roles/${rid}/assignments`, { subject_type: 'ad_group', ad_dn: 'CN=G,DC=x,DC=y', ad_name: 'G' });
  assert.equal(ad.status, 400);
  assert.match(ad.json.error, /Active Directory is not enabled/);
  const list = await admin.call('GET', `/api/access/roles/${rid}/assignments`);
  assert.equal(list.json.rows.length, 1);
  assert.equal(list.json.rows[0].ad_dn, null);
  assert.equal((await app.login('erin', PW)).call !== undefined, true);
  const rm = await admin.call('DELETE', `/api/access/roles/${rid}/assignments/${add.json.id}`);
  assert.equal(rm.status, 200);
  assert.equal((await admin.call('DELETE', `/api/access/roles/${rid}/assignments/${add.json.id}`)).status, 404);
  assert.equal((await admin.call('GET', '/api/access/roles/99999/assignments')).status, 404);
});

test('events: newest first, kind filter, limit; every mutation is recorded with its actor', async () => {
  const r = await admin.call('GET', '/api/access/events?limit=500');
  assert.equal(r.status, 200);
  const rows = r.json.rows;
  assert.ok(rows.length > 10);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].id > rows[i].id);
  const kinds = new Set(rows.map((x) => x.kind));
  for (const k of ['login_ok', 'login_fail', 'user_created', 'user_updated', 'user_deleted', 'role_created', 'role_updated', 'role_deleted', 'assignment_added', 'assignment_removed']) {
    assert.ok(kinds.has(k), `has ${k}`);
  }
  const created = rows.find((x) => x.kind === 'user_created' && x.username === 'carol');
  assert.ok(created.actor_user_id > 0);
  const only = await admin.call('GET', '/api/access/events?kind=role_created');
  assert.ok(only.json.rows.length >= 1);
  assert.ok(only.json.rows.every((x) => x.kind === 'role_created'));
  assert.equal((await admin.call('GET', '/api/access/events?kind=bogus')).status, 400);
  assert.equal((await admin.call('GET', '/api/access/events?limit=2')).json.rows.length, 2);
});

test('directory settings live under /api/access/directory: GET /api/settings hides ad.*, PUT /api/settings refuses them', async () => {
  const s = await admin.call('GET', '/api/settings');
  assert.equal(s.status, 200);
  assert.deepEqual(Object.keys(s.json).filter((k) => k.startsWith('ad.')), []);
  const put = await admin.call('PUT', '/api/settings', { patch: { 'ad.enabled': true } });
  assert.equal(put.status, 400);
  assert.equal(put.json.error, 'Directory settings are saved under /api/access/directory');
  const d = await admin.call('GET', '/api/access/directory');
  assert.equal(d.status, 200);
  assert.deepEqual(d.json.config['ad.bind_password'], { set: false });
  assert.equal(d.json.config['ad.enabled'], false);
  assert.equal(d.json.config['ad.tls_mode'], 'auto');
  assert.equal(d.json.config['ad.sync_minutes'], 60);
  assert.equal(d.json.user_count, 0);
  const bad = await admin.call('PUT', '/api/access/directory', { patch: { 'ad.sync_minutes': 2 } });
  assert.equal(bad.status, 400);
  assert.equal((await admin.call('PUT', '/api/access/directory', { patch: { 'ad.tls_mode': 'plain' } })).status, 400);
  assert.equal((await admin.call('PUT', '/api/access/directory', { patch: { 'ad.discovered': {} } })).status, 400);
  // AD off: search and sync refuse, the test checklist still answers 200 with the first step failed
  assert.equal((await admin.call('GET', '/api/access/directory/search?type=user&q=a')).status, 400);
  assert.equal((await admin.call('POST', '/api/access/directory/sync', {})).status, 400);
  const t = await admin.call('POST', '/api/access/directory/test', {});
  assert.equal(t.status, 200);
  assert.equal(t.json.ok, false);
  assert.equal(t.json.steps[0].key, 'dns');
  assert.equal(t.json.steps[0].ok, false);
  assert.match(t.json.steps[0].detail, /domain is not set/);
});

test('access.changed is broadcast on mutations', async () => {
  const res = await fetch(`${app.base}/api/events`, { headers: { cookie: admin.cookie } });
  const reader = res.body.getReader();
  await reader.read(); // hello
  await admin.call('POST', '/api/access/roles', { name: 'Broadcast role', permissions: ['dashboard.view'] });
  let text = '';
  const t0 = Date.now();
  while (!text.includes('access.changed') && Date.now() - t0 < 3000) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  await reader.cancel();
  assert.match(text, /"type":"access.changed","id":null,"at":"[^"]+","what":"roles"/);
});
