'use strict';
// Data scopes (CONTRACT section 15). People are re-labelled into LOB A and LOB B (plus a few Unassigned and a few
// with no people row at all), a LOB manager is granted A, and every data route is checked for leaks of B.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
const authService = require('../src/services/authService');
const measures = require('../src/services/measures');
const rollups = require('../src/services/rollups');
const scopeMod = require('../src/services/scope');
const permissions = require('../src/services/permissions');
const { requiredFor } = require('../src/auth');

const db = ctx.db.getDb();
const PW = 'a-long-password-1';
const A = 'LOB A';
const B = 'LOB B';
const PLATFORMS = ['anthropic', 'openai', 'github', 'cowork'];
let app;
let admin;
let mgr;
let dsId;
let range;
let keysByLob;
let namesB;
let roleLob;

const roleId = (name) => db.prepare('SELECT id FROM roles WHERE name = ?').get(name).id;

async function mkUser(username, roleIds, lob) {
  const r = await admin.call('POST', '/api/access/users', { username, password: PW, role_ids: roleIds, lob_cg: lob });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test.before(async () => {
  seedFixture({ people: 60, months: 3, endDate: '2026-10-30', seed: 7, profile: 'clean' });
  dsId = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;
  const people = db.prepare('SELECT person_key FROM people WHERE dataset_id = ? ORDER BY person_key').all(dsId).map((r) => r.person_key);
  keysByLob = { A: [], B: [], U: [], none: [] };
  people.forEach((k, i) => {
    if (i < 3) keysByLob.none.push(k);
    else if (i < 8) keysByLob.U.push(k);
    else if (i % 2 === 0) keysByLob.A.push(k);
    else keysByLob.B.push(k);
  });
  const set = db.prepare('UPDATE people SET lob_cg = ?, lob_cg_sort = ? WHERE dataset_id = ? AND person_key = ?');
  for (const k of keysByLob.A) set.run(A, 1, dsId, k);
  for (const k of keysByLob.B) set.run(B, 2, dsId, k);
  for (const k of keysByLob.U) set.run('Unassigned', 999, dsId, k);
  // no people row at all: the usage of these keys is "Unmatched usage"
  for (const k of keysByLob.none) db.prepare('DELETE FROM people WHERE dataset_id = ? AND person_key = ?').run(dsId, k);
  rollups.rebuildOrg(db, dsId);
  namesB = db.prepare('SELECT person_key, display_name, email FROM people WHERE dataset_id = ? AND lob_cg = ?').all(dsId, B);

  app = await startApp();
  admin = await app.admin();
  const role = await admin.call('POST', '/api/access/roles', { name: 'LOB manager', description: 'test', permissions: ['dashboard.view', 'people.view', 'export.csv'] });
  assert.equal(role.status, 201, role.text);
  roleLob = role.json.id;
  const u = await mkUser('mgr.a', [roleLob]);
  const g = await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: u.id, dim: 'lob_cg', values: [A] });
  assert.equal(g.status, 201, g.text);
  mgr = await app.login('mgr.a', PW);
  const s = await admin.call('GET', '/api/summary');
  range = s.json.range;
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

const q = (extra) => `from=${range.from}&to=${range.to}${extra ? `&${extra}` : ''}`;
const sqlA = (lob) => ({
  spend: Object.fromEntries(db.prepare(
    `SELECT pd.platform, sum(pd.cost_usd) AS usd FROM rollup_person_day pd JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND p.lob_cg = ? AND pd.date BETWEEN ? AND ? GROUP BY pd.platform`
  ).all(dsId, lob, range.from, range.to).map((r) => [r.platform, r.usd])),
  active: db.prepare(
    `SELECT count(DISTINCT pd.person_key) AS n FROM rollup_person_day pd JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND p.lob_cg = ? AND pd.date BETWEEN ? AND ? AND (pd.cost_usd > 0 OR pd.tokens > 0 OR pd.credits > 0)`
  ).get(dsId, lob, range.from, range.to).n,
});
const near = (a, b, msg, tol = 0.011) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

test('measures.resolve without a scope throws, and a scoped empty scope answers no_scope', () => {
  assert.throws(() => measures.resolve({}), /scope missing/);
  assert.throws(() => measures.resolve({}, null), /scope missing/);
  assert.throws(() => measures.resolve({}, { all: false, lob_cg: [] }), (e) => e.status === 403 && e.code === 'no_scope');
  assert.ok(measures.resolve({}, { all: true, lob_cg: [] }));
  assert.equal(scopeMod.isEmpty({ all: false, lob_cg: [] }), true);
  assert.equal(scopeMod.isEmpty({ all: true, lob_cg: [] }), false);
});

test('peopleWhere and lobVisible', () => {
  assert.deepEqual(scopeMod.peopleWhere({ all: true, lob_cg: [] }), { sql: '', params: [] });
  const w = scopeMod.peopleWhere({ all: false, lob_cg: [A, 'Unassigned'] }, 'x');
  assert.match(w.sql, /x\.lob_cg IN \(\?\)/);
  assert.match(w.sql, /x\.lob_cg IS NULL/);
  assert.deepEqual(w.params, [A]);
  assert.equal(scopeMod.lobVisible({ all: false, lob_cg: [A] }, A), true);
  assert.equal(scopeMod.lobVisible({ all: false, lob_cg: [A] }, B), false);
  assert.equal(scopeMod.lobVisible({ all: false, lob_cg: [A] }, 'unknown'), false);
  assert.equal(scopeMod.lobVisible({ all: false, lob_cg: ['Unassigned'] }, ''), true);
  assert.equal(scopeMod.lobVisible({ all: true, lob_cg: [] }, B), true);
});

test('data.all is the seventh permission and the system roles carry it as specified', () => {
  assert.equal(permissions.KEYS.length, 7);
  assert.equal(permissions.KEYS[6], 'data.all');
  const role = (n) => JSON.parse(db.prepare('SELECT permissions_json FROM roles WHERE name = ?').get(n).permissions_json);
  assert.equal(role('Administrator').length, 7);
  assert.deepEqual(role('Executive'), ['dashboard.view', 'export.csv', 'data.all']);
  assert.deepEqual(role('Analyst'), ['dashboard.view', 'people.view', 'export.csv', 'data.all']);
  assert.deepEqual(role('Viewer'), ['dashboard.view']);
  assert.deepEqual(requiredFor('GET', '/verification/runs/3'), ['dashboard.view', 'data.all']);
  assert.deepEqual(requiredFor('GET', '/verification'), ['dashboard.view']);
});

test('session body carries the scope', async () => {
  const s = await mgr.call('GET', '/api/auth/session');
  assert.deepEqual(s.json.scope, { all: false, lob_cg: [A] });
  assert.deepEqual((await admin.call('GET', '/api/auth/session')).json.scope, { all: true, lob_cg: [] });
});

test('summary: spend per platform and active users equal the SQL for LOB A', async () => {
  const exp = sqlA(A);
  const r = await mgr.call('GET', `/api/summary?${q()}`);
  assert.equal(r.status, 200, r.text);
  let total = 0;
  for (const p of r.json.platforms) {
    near(p.spend.consumption.usd, exp.spend[p.id] || 0, `spend ${p.id}`);
    total += exp.spend[p.id] || 0;
  }
  near(r.json.totals.spend.consumption.usd, total, 'total spend');
  assert.equal(r.json.totals.active_users, exp.active);
  assert.equal(r.json.seat_basis_note, 'Seat spend allocated to your lines of business by active people');
  const whole = await admin.call('GET', `/api/summary?${q()}`);
  assert.equal(whole.json.seat_basis_note, undefined);
  assert.ok(r.json.totals.spend.consumption.usd < whole.json.totals.spend.consumption.usd);
  assert.equal(r.json.dataset.counts.people, keysByLob.A.length);
});

test('trend: buckets sum to the same spend and the active users match', async () => {
  const exp = sqlA(A);
  const r = await mgr.call('GET', `/api/trend?grain=day&${q()}`);
  assert.equal(r.status, 200, r.text);
  const total = r.json.buckets.reduce((a, b) => a + b.total_usd, 0);
  // every day and platform cell is rounded to cents, so allow a cent per cell
  near(total, Object.values(exp.spend).reduce((a, b) => a + b, 0), 'trend total', 1);
  const w = await mgr.call('GET', `/api/trend?grain=week&${q()}`);
  near(w.json.buckets.reduce((a, b) => a + b.total_usd, 0), total, 'weekly total', 1);
});

test('platform page: spend and top users are all A; top users hide without people.view', async () => {
  const exp = sqlA(A);
  for (const id of PLATFORMS) {
    const r = await mgr.call('GET', `/api/platforms/${id}?${q()}`);
    assert.equal(r.status, 200, r.text);
    near(r.json.spend.consumption.usd, exp.spend[id] || 0, `platform ${id}`);
    for (const u of r.json.top_users) assert.equal(u.lob_cg, A);
    assert.ok(keysByLob.B.every((k) => !JSON.stringify(r.json).includes(`"${k}"`)));
    assert.ok(r.json.seat_basis_note);
  }
  // a scoped caller without people.view gets no names
  const viewerRole = roleId('Viewer');
  const u = await mkUser('nopeople', [viewerRole], [A]);
  assert.ok(u.id);
  const c = await app.login('nopeople', PW);
  const r = await c.call('GET', `/api/platforms/anthropic?${q()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.top_users, []);
  assert.equal(r.json.top_users_hidden, true);
  const csv = await c.call('GET', '/api/export/platform.csv?platform=anthropic');
  assert.equal(csv.status, 403); // export.csv is not part of Viewer
});

test('models: rows, user counts and model top users are all A', async () => {
  const r = await mgr.call('GET', `/api/models?${q()}`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.rows.length > 0);
  const usersExp = new Map(db.prepare(
    `SELECT u.platform, u.model, count(DISTINCT u.person_key) AS n FROM usage u JOIN people p ON p.dataset_id = u.dataset_id AND p.person_key = u.person_key
     WHERE u.dataset_id = ? AND p.lob_cg = ? AND u.date BETWEEN ? AND ? AND u.model <> '' AND (coalesce(u.cost_usd,0) > 0 OR coalesce(u.tokens,0) > 0 OR coalesce(u.credits,0) > 0)
     GROUP BY u.platform, u.model`
  ).all(dsId, A, range.from, range.to).map((x) => [`${x.platform}|${x.model}`, x.n]));
  for (const row of r.json.rows) assert.equal(row.users, usersExp.get(`${row.platform}|${row.model}`));
  const first = r.json.rows[0];
  const d = await mgr.call('GET', `/api/models/${first.platform}/${encodeURIComponent(first.model)}?${q()}`);
  assert.equal(d.status, 200, d.text);
  assert.ok(d.json.top_users.length > 0);
  for (const u of d.json.top_users) assert.equal(u.lob_cg, A);
  const whole = await admin.call('GET', `/api/models?${q()}`);
  assert.ok(whole.json.rows.reduce((a, x) => a + x.usd, 0) > r.json.rows.reduce((a, x) => a + x.usd, 0));
});

test('organization: only the granted LOB, no Unmatched, no Unassigned, cells outside the grant are 403', async () => {
  const exp = sqlA(A);
  const r = await mgr.call('GET', `/api/organization?dim=lob_cg&${q()}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.rows.map((x) => x.label), [A]);
  assert.deepEqual(r.json.scope, { all: false, lob_cg: [A] });
  near(r.json.totals.total.usd, Object.values(exp.spend).reduce((a, b) => a + b, 0), 'org total');
  const wholeOrg = await admin.call('GET', `/api/organization?dim=lob_cg&${q()}`);
  const labels = wholeOrg.json.rows.map((x) => x.label);
  assert.ok(labels.includes(B) && labels.includes('Unassigned') && labels.includes('Unmatched usage'));
  const bKey = wholeOrg.json.rows.find((x) => x.label === B).key;
  const aKey = wholeOrg.json.rows.find((x) => x.label === A).key;
  const cellB = await mgr.call('GET', `/api/organization/cell?dim=lob_cg&key=${bKey}&platform=anthropic&${q()}`);
  assert.equal(cellB.status, 403);
  assert.equal(cellB.json.code, 'out_of_scope');
  assert.equal((await mgr.call('GET', `/api/organization/cell?dim=lob_cg&key=__unmatched__&platform=anthropic&${q()}`)).status, 403);
  assert.equal((await mgr.call('GET', `/api/organization/cell?dim=lob_cg&key=__unassigned__&platform=anthropic&${q()}`)).status, 403);
  const cellA = await mgr.call('GET', `/api/organization/cell?dim=lob_cg&key=${aKey}&platform=anthropic&${q()}`);
  assert.equal(cellA.status, 200, cellA.text);
  assert.ok(cellA.json.contributors.length > 0);
  assert.ok(cellA.json.contributors.every((c) => keysByLob.A.includes(c.person_key)));
  // other dims are computed over the scoped people only
  const reg = await mgr.call('GET', `/api/organization?dim=region&${q()}`);
  assert.equal(reg.status, 200);
  near(reg.json.totals.total.usd, r.json.totals.total.usd, 'region total ties to the scope');
  assert.ok(!reg.json.rows.some((x) => x.key === '__unmatched__'));
});

test('users: rows are all A, a B filter is empty, a B person is 404', async () => {
  const r = await mgr.call('GET', `/api/users?pageSize=200&${q()}`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.rows.length > 0);
  assert.ok(r.json.rows.every((x) => x.lob_cg === A && keysByLob.A.includes(x.person_key)));
  const b = await mgr.call('GET', `/api/users?lob_cg=${encodeURIComponent(B)}&${q()}`);
  assert.equal(b.status, 200);
  assert.equal(b.json.total, 0);
  assert.deepEqual(b.json.rows, []);
  const bk = keysByLob.B[0];
  const d = await mgr.call('GET', `/api/users/${encodeURIComponent(bk)}`);
  assert.equal(d.status, 404);
  assert.equal(d.json.error, 'No such user');
  const missing = await mgr.call('GET', '/api/users/nobody-at-all');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'No such user', 'missing and outside the scope look the same');
  const unmatched = await mgr.call('GET', `/api/users/${encodeURIComponent(keysByLob.none[0])}`);
  assert.equal(unmatched.status, 404);
  const ok = await mgr.call('GET', `/api/users/${encodeURIComponent(keysByLob.A[0])}?${q()}`);
  assert.equal(ok.status, 200);
  assert.equal((await admin.call('GET', `/api/users/${encodeURIComponent(keysByLob.B[0])}`)).status, 200);
});

function assertNoB(text, label) {
  for (const p of namesB) {
    assert.ok(!text.includes(p.person_key), `${label}: leaks person key ${p.person_key}`);
    if (p.display_name && !keysByLob.A.includes(p.display_name)) {
      const clash = db.prepare('SELECT 1 FROM people WHERE dataset_id = ? AND lob_cg = ? AND (display_name = ? OR email = ?)').get(dsId, A, p.display_name, p.email);
      if (!clash) assert.ok(!text.includes(p.display_name), `${label}: leaks name ${p.display_name}`);
    }
  }
  assert.ok(!text.includes(B), `${label}: leaks ${B}`);
}

test('every report answers 200 for the manager and carries nothing of B; users_unmatched is empty with a note', async () => {
  const cat = await mgr.call('GET', '/api/reports');
  const ids = cat.json.reports.map((x) => x.id);
  assert.equal(ids.length, 17);
  for (const id of ids) {
    const r = await mgr.call('GET', `/api/reports/${id}?${q()}`);
    assert.equal(r.status, 200, `${id}: ${r.text.slice(0, 200)}`);
    assertNoB(r.text, `report ${id}`);
    assert.ok(!r.text.includes('Unmatched usage') || id === 'users_unmatched', `${id} shows the Unmatched bucket`);
    if (id === 'users_unmatched') {
      assert.deepEqual(r.json.rows, []);
      assert.equal(r.json.note, 'Unmatched usage is only visible with the data.all permission');
    }
    const csv = await mgr.call('GET', `/api/export/report/${id}.csv?${q()}`);
    assert.equal(csv.status, 200, `${id} csv`);
    assertNoB(csv.text, `report csv ${id}`);
  }
});

test('exports carry nothing of B', async () => {
  for (const u of [`/api/export/users.csv?${q()}`, `/api/export/platform.csv?platform=anthropic&${q()}`, `/api/export/platform.csv?platform=github&${q()}`,
    `/api/export/summary.csv?${q()}`, `/api/export/trend.csv?${q()}`, `/api/export/organization.csv?${q()}`, `/api/export/models.csv?${q()}`]) {
    const r = await mgr.call('GET', u);
    assert.equal(r.status, 200, u);
    assertNoB(r.text, u);
  }
  const users = await mgr.call('GET', `/api/export/users.csv?${q()}`);
  assert.ok(keysByLob.A.some((k) => users.text.includes(k)), 'the manager still gets their own people');
});

test('verification evidence needs data.all; the summary stays open', async () => {
  const v = await admin.call('GET', '/api/verification');
  assert.equal((await mgr.call('GET', '/api/verification')).status, 200);
  const runId = v.json.run.id;
  const r = await mgr.call('GET', `/api/verification/runs/${runId}`);
  assert.equal(r.status, 403);
  assert.equal(r.json.required, 'data.all');
  const c = await mgr.call('GET', `/api/verification/runs/${runId}/checks/${v.json.checks[0].id}`);
  assert.equal(c.status, 403);
  assert.equal((await admin.call('GET', `/api/verification/runs/${runId}`)).status, 200);
});

test('a user with the role but no grant: no_scope everywhere, the session still works', async () => {
  await mkUser('empty.scope', [roleLob]);
  const c = await app.login('empty.scope', PW);
  for (const u of ['/api/summary', '/api/users', '/api/reports/costs_monthly', '/api/export/summary.csv', '/api/organization', '/api/models', '/api/trend', '/api/platforms/anthropic']) {
    const r = await c.call('GET', u);
    assert.equal(r.status, 403, u);
    assert.equal(r.json.code, 'no_scope', u);
    assert.match(r.json.error, /No data scope is assigned/);
  }
  const s = await c.call('GET', '/api/auth/session');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.scope, { all: false, lob_cg: [] });
});

test('data.all: an Executive sees exactly what the administrator sees', async () => {
  await mkUser('coo', [roleId('Executive')]);
  const c = await app.login('coo', PW);
  const a = await admin.call('GET', `/api/summary?${q()}`);
  const b = await c.call('GET', `/api/summary?${q()}`);
  assert.equal(b.status, 200);
  assert.deepEqual(b.json, a.json);
  assert.deepEqual((await c.call('GET', `/api/organization?${q()}`)).json, (await admin.call('GET', `/api/organization?${q()}`)).json);
  assert.deepEqual((await c.call('GET', '/api/auth/session')).json.scope, { all: true, lob_cg: [] });
});

test('the Unassigned grant shows the Unassigned people and nothing else', async () => {
  const u = await mkUser('unas', [roleLob], ['Unassigned']);
  assert.ok(u.id);
  const c = await app.login('unas', PW);
  const r = await c.call('GET', `/api/users?pageSize=200&${q()}`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.rows.length > 0);
  assert.ok(r.json.rows.every((x) => keysByLob.U.includes(x.person_key)));
  const org = await c.call('GET', `/api/organization?dim=lob_cg&${q()}`);
  assert.deepEqual(org.json.rows.map((x) => x.key), ['__unassigned__']);
  assert.equal((await c.call('GET', `/api/organization/cell?dim=lob_cg&key=__unassigned__&platform=anthropic&${q()}`)).status, 200);
  const un = await c.call('GET', `/api/reports/users_unmatched?${q()}`);
  assert.deepEqual(un.json.rows, []);
});

test('seat allocation: scoped seat spend is the whole figure times the LOB share of active people', async () => {
  const ym = range.to.slice(0, 7);
  // a whole calendar month so proration is exactly one month
  const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
  const full = `from=${ym}-01&to=${ym}-${String(last).padStart(2, '0')}&basis=seat`;
  const whole = await admin.call('GET', `/api/summary?${full}`);
  const mine = await mgr.call('GET', `/api/summary?${full}`);
  assert.equal(mine.status, 200, mine.text);
  let checked = 0;
  for (const p of whole.json.platforms) {
    const row = db.prepare(
      `SELECT sum(CASE WHEN lob_cg = ? THEN active_users ELSE 0 END) AS a, sum(active_users) AS t FROM rollup_org_month
       WHERE dataset_id = ? AND matched = 1 AND month = ? AND platform = ?`
    ).get(A, dsId, ym, p.id);
    const share = row && row.t > 0 ? row.a / row.t : 0;
    const got = mine.json.platforms.find((x) => x.id === p.id).spend.seat.usd;
    near(got, p.spend.seat.usd * share, `seat ${p.id}`);
    if (p.spend.seat.usd > 0) checked += 1;
  }
  assert.ok(checked > 0, 'at least one platform has seat spend to check');
  const mineTotal = mine.json.totals.spend.seat.usd;
  assert.ok(mineTotal < whole.json.totals.spend.seat.usd);
});

test('AD users get grants through a group DN, an OU suffix at a comma boundary, and nothing for a partial OU name', () => {
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO users (username, display_name, source, active, ad_dn, ad_groups_json, created_at, updated_at) VALUES (?, ?, 'ad', 1, ?, ?, ?, ?)");
  const base = 'DC=corp,DC=test';
  const grp = `CN=Finance,OU=Groups,${base}`;
  const eng = ins.run('ad.eng', 'AD Eng', `CN=Eng User,OU=Sales,${base}`, JSON.stringify([grp, 'S-1-5-21-5']), now, now).lastInsertRowid;
  const pre = ins.run('ad.pre', 'AD Pre', `CN=Pre User,OU=Presales,${base}`, JSON.stringify([]), now, now).lastInsertRowid;
  const loc = db.prepare("INSERT INTO users (username, display_name, source, active, created_at, updated_at) VALUES ('loc.only', 'Local', 'local', 1, ?, ?)").run(now, now).lastInsertRowid;
  const g = db.prepare("INSERT INTO scope_grants (subject_type, user_id, ad_dn, ad_sid, ad_name, dim, value, created_at) VALUES (?, 0, ?, ?, ?, 'lob_cg', ?, ?)");
  g.run('ad_group', grp, null, 'Finance', 'LOB Fin', now);
  g.run('ad_ou', `OU=Sales,${base}`, null, 'Sales', 'LOB Sales', now);
  g.run('ad_group', 'CN=Sidgroup,OU=Groups,DC=corp,DC=test', 'S-1-5-21-5', 'Sid', 'LOB BySid', now);
  const e1 = authService.effective(authService.userById(eng));
  assert.deepEqual(e1.scope.lob_cg, ['LOB BySid', 'LOB Fin', 'LOB Sales']);
  assert.deepEqual(e1.scope.via['LOB Fin'], ['group:Finance']);
  assert.deepEqual(e1.scope.via['LOB Sales'], ['ou:Sales']);
  assert.equal(e1.scope.all, false);
  const e2 = authService.effective(authService.userById(pre));
  assert.deepEqual(e2.scope.lob_cg, [], 'OU=Sales must not match OU=Presales');
  const e3 = authService.effective(authService.userById(loc));
  assert.deepEqual(e3.scope.lob_cg, [], 'local users only get direct grants');
  db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(eng, pre, loc);
  db.prepare("DELETE FROM scope_grants WHERE subject_type <> 'user'").run();
});

test('access routes: scope values, create, list, duplicates, delete, users rows, PUT lob_cg and the audit trail', async () => {
  const vals = await admin.call('GET', '/api/access/scope-values');
  assert.equal(vals.status, 200);
  const byValue = Object.fromEntries(vals.json.values.map((v) => [v.value, v]));
  assert.equal(byValue[A].people, keysByLob.A.length);
  assert.equal(byValue[B].people, keysByLob.B.length);
  assert.equal(byValue.Unassigned.sort, 998);
  assert.equal(byValue.Unassigned.people, keysByLob.U.length);
  assert.ok(vals.json.values.every((v) => v.dim === 'lob_cg'));

  const u = await mkUser('scoped.u', [roleLob]);
  const bad = await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: u.id, dim: 'region', values: [A] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'Only LOB-CG scopes are supported');
  assert.equal((await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: u.id, values: [] })).status, 400);
  assert.equal((await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: 99999, values: [A] })).status, 400);
  assert.equal((await admin.call('POST', '/api/access/scopes', { subject_type: 'ad_group', ad_dn: 'CN=G,DC=x', values: [A] })).status, 400, 'AD subjects need AD enabled');

  const made = await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: u.id, values: [A, B, 'Gone LOB'] });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(made.json.rows.map((r) => r.value).sort(), [A, B, 'Gone LOB'].sort());
  assert.equal(made.json.rows.find((r) => r.value === 'Gone LOB').in_active_dataset, false);
  const again = await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: u.id, values: [A] });
  assert.equal(again.json.rows.length, 3, 'a duplicate value is skipped');
  assert.ok((await admin.call('GET', '/api/access/scope-values')).json.values.some((v) => v.value === 'Gone LOB' && v.in_active_dataset === false));

  const list = await admin.call('GET', '/api/access/scopes');
  assert.ok(list.json.rows.every((r) => r.dim === 'lob_cg' && 'created_at' in r && 'in_active_dataset' in r));
  assert.equal(list.json.rows.find((r) => r.user && r.user.username === 'scoped.u' && r.value === A).user.source, 'local');

  const users = await admin.call('GET', '/api/access/users');
  const row = users.json.rows.find((r) => r.username === 'scoped.u');
  assert.equal(row.scope.all, false);
  assert.deepEqual(row.scope.lob_cg.map((x) => x.value).sort(), [A, B, 'Gone LOB'].sort());
  assert.ok(row.scope.lob_cg.every((x) => x.via === 'direct'));
  assert.equal(users.json.rows.find((r) => r.username === 'admin').scope.all, true);

  const put = await admin.call('PUT', `/api/access/users/${u.id}`, { lob_cg: [B] });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json.scope.lob_cg.map((x) => x.value), [B]);
  assert.equal((await admin.call('PUT', `/api/access/users/${u.id}`, { lob_cg: 'x' })).status, 400);

  const one = list.json.rows.find((r) => r.user && r.user.username === 'mgr.a');
  const del = await admin.call('DELETE', `/api/access/scopes/${one.id}`);
  assert.equal(del.status, 200);
  assert.equal((await admin.call('DELETE', `/api/access/scopes/${one.id}`)).status, 404);
  assert.deepEqual((await mgr.call('GET', '/api/auth/session')).json.scope, { all: false, lob_cg: [] });
  assert.equal((await mgr.call('GET', '/api/summary')).status, 403);
  await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: one.user.id, values: [A] });
  assert.equal((await mgr.call('GET', '/api/summary')).status, 200);

  const ev = await admin.call('GET', '/api/access/events?limit=200');
  const kinds = new Set(ev.json.rows.map((e) => e.kind));
  assert.ok(kinds.has('scope_added') && kinds.has('scope_removed'));
  assert.equal((await admin.call('GET', '/api/access/events?kind=scope_added')).status, 200);
  const added = ev.json.rows.find((e) => e.kind === 'scope_added');
  assert.ok(added.actor_user_id);
  assert.ok(!/password/i.test(added.detail || ''));

  // the permission gate: a manager cannot read the scope routes
  assert.equal((await mgr.call('GET', '/api/access/scopes')).status, 403);
  // deleting a user removes their direct grants
  assert.equal((await admin.call('DELETE', `/api/access/users/${u.id}`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scope_grants WHERE subject_type = 'user' AND user_id = ?").get(u.id).n, 0);
});

test('the access.changed broadcast carries what: scopes', async () => {
  const res = await fetch(`${app.base}/api/events`, { headers: { cookie: admin.cookie } });
  const reader = res.body.getReader();
  await reader.read(); // hello
  const u = db.prepare("SELECT id FROM users WHERE username = 'mgr.a'").get();
  await admin.call('POST', '/api/access/scopes', { subject_type: 'user', user_id: u.id, values: [B] });
  const dec = new TextDecoder();
  let text = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !/"what":"scopes"/.test(text)) {
    const { value } = await reader.read();
    text += dec.decode(value);
  }
  await reader.cancel();
  assert.match(text, /access\.changed/);
  assert.match(text, /"what":"scopes"/);
  const g = db.prepare("SELECT id FROM scope_grants WHERE user_id = ? AND value = ?").get(u.id, B);
  await admin.call('DELETE', `/api/access/scopes/${g.id}`);
});
