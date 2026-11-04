'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
const events = require('../src/services/events');
const db = ctx.db.getDb();
let app;

test.before(async () => {
  seedFixture({ people: 80, months: 3, endDate: '2026-10-30', seed: 9, profile: 'clean' });
  app = await startApp();
  app.call = (await app.admin()).call; // signed in as admin / M0nkside
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

const dsId = () => db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;

test('validators accept good values and reject bad ones with 400', async () => {
  const put = (patch) => app.call('PUT', '/api/settings', { patch });
  const bad = [
    { 'spend.seat_basis': 'nope' }, { 'spend.default_basis': 'x' }, { 'cowork.rate': -1 }, { 'cowork.rate': 'abc' },
    { 'cowork.rate_confirmed': 'yes' }, { 'verify.stale_days': 1.5 }, { 'verify.gap_days': -2 }, { 'verify.unmatched_pct': 101 },
    { 'verify.delta_pct': 'many' }, { 'datasets.keep': 0 }, { 'fixture.options': { seed: 1, months: 99, people: 400, profile: 'clean' } },
    { 'fixture.options': { seed: 1, months: 3, people: 400, profile: 'odd' } }, { 'fixture.options': 5 },
    { 'lobcg.seed': 'text' }, { 'lobcg.seed': [{ lob_cg: '', lob_cg_sort: 1 }] },
    { 'lobcg.seed': [{ lob_cg: 'A', lob_cg_sort: 1 }, { lob_cg: 'A', lob_cg_sort: 2 }] },
  ];
  for (const b of bad) {
    const r = await put(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.ok(r.json.error);
  }
  const ok = await put({
    'spend.seat_basis': 'active', 'spend.default_basis': 'total', 'cowork.rate': 0.01, 'cowork.rate_confirmed': true,
    'verify.stale_days': 7, 'verify.unmatched_pct': 2.5, 'datasets.keep': 3,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json['spend.seat_basis'], 'active');
  assert.equal(ok.json['cowork.rate'], 0.01);
  assert.equal((await app.call('GET', '/api/settings')).json['verify.stale_days'], 7);
  // a bad key in a mixed patch applies nothing
  const mixed = await put({ 'verify.gap_days': 3, 'datasets.keep': 0 });
  assert.equal(mixed.status, 400);
  assert.equal((await app.call('GET', '/api/settings')).json['verify.gap_days'], 2);
  await put({ 'spend.seat_basis': 'licensed', 'spend.default_basis': 'consumption', 'cowork.rate': 0.008, 'cowork.rate_confirmed': false });
});

test('default basis setting drives responses; seat_basis active uses active people', async () => {
  await app.call('PUT', '/api/settings', { patch: { 'spend.default_basis': 'total' } });
  assert.equal((await app.call('GET', '/api/trend?grain=week')).json.basis, 'total');
  assert.equal((await app.call('GET', '/api/trend?grain=week&basis=seat')).json.basis, 'seat');
  await app.call('PUT', '/api/settings', { patch: { 'spend.default_basis': 'consumption' } });
  const lic = (await app.call('GET', '/api/summary')).json.totals.spend.seat.usd;
  await app.call('PUT', '/api/settings', { patch: { 'spend.seat_basis': 'active' } });
  const act = (await app.call('GET', '/api/summary')).json;
  assert.equal(act.seat.estimate, true);
  await app.call('PUT', '/api/settings', { patch: { 'spend.seat_basis': 'licensed' } });
  assert.ok(act.totals.spend.seat.usd > 0 && act.totals.spend.seat.usd !== lic, `${act.totals.spend.seat.usd} vs ${lic}`);
});

test('settings.changed is broadcast with the changed keys', async () => {
  const seen = [];
  const res = { writeHead() {}, flushHeaders() {}, write(s) { seen.push(s); } };
  const req = { on() {} };
  events.addClient(req, res);
  await app.call('PUT', '/api/settings', { patch: { 'verify.stale_days': 9 } });
  assert.ok(seen.some((s) => s.includes('settings.changed') && s.includes('verify.stale_days')));
  const before = seen.length;
  await app.call('PUT', '/api/settings', { patch: { 'verify.stale_days': 9 } });
  assert.equal(seen.length, before, 'no event when nothing changed');
});

test('seat-rates: GET, PUT replaces rows, rebuilds org rollup, broadcasts', async () => {
  const g = (await app.call('GET', '/api/settings/seat-rates')).json;
  assert.ok(g.rows.length >= 8);
  assert.deepEqual(Object.keys(g.rows[0]).sort(), ['licensed_seats', 'month', 'platform', 'rate_usd']);
  const seen = [];
  events.addClient({ on() {} }, { writeHead() {}, flushHeaders() {}, write(s) { seen.push(s); } });
  db.prepare('DELETE FROM rollup_org_month WHERE dataset_id = ?').run(dsId());
  const rows = g.rows.map((r) => (r.platform === 'github' ? { ...r, rate_usd: 100, licensed_seats: 10 } : r));
  const p = await app.call('PUT', '/api/settings/seat-rates', { rows });
  assert.equal(p.status, 200, p.text);
  assert.ok(db.prepare('SELECT count(*) n FROM rollup_org_month WHERE dataset_id = ?').get(dsId()).n > 0, 'org rollup rebuilt');
  assert.ok(seen.some((s) => s.includes('settings.changed') && s.includes('seat-rates')));
  const s = (await app.call('GET', '/api/summary?from=2026-09-01&to=2026-09-30')).json;
  const gh = s.platforms.find((x) => x.id === 'github');
  assert.equal(gh.spend.seat.usd, 1000);
  assert.equal((await app.call('PUT', '/api/settings/seat-rates', { rows: [rows[0], rows[0]] })).status, 400);
  assert.equal((await app.call('PUT', '/api/settings/seat-rates', { rows: [{ platform: 'zzz', month: '2026-01', rate_usd: 1, licensed_seats: 1 }] })).status, 400);
  assert.equal((await app.call('PUT', '/api/settings/seat-rates', { rows: [{ platform: 'github', month: '2026-1', rate_usd: 1, licensed_seats: 1 }] })).status, 400);
  assert.equal((await app.call('PUT', '/api/settings/seat-rates', { rows: [{ platform: 'github', month: '2026-01', rate_usd: -1, licensed_seats: 1 }] })).status, 400);
  assert.equal((await app.call('PUT', '/api/settings/seat-rates', {})).status, 400);
});

test('lob-cg-map: PUT rewrites people.lob_cg and rebuilds rollup_org_month', async () => {
  const g = (await app.call('GET', '/api/settings/lob-cg-map')).json;
  assert.ok(g.rows.length > 5);
  assert.deepEqual(Object.keys(g.rows[0]).sort(), ['job_function', 'lob_cg', 'lob_cg_sort', 'u_lob_2']);
  const ds = dsId();
  const before = db.prepare("SELECT count(*) n FROM people WHERE dataset_id = ? AND lob_cg = 'Legal Team'").get(ds).n;
  assert.equal(before, 0);
  const rows = g.rows.map((r) => (r.lob_cg === 'GBS - L&C' ? { ...r, lob_cg: 'Legal Team', lob_cg_sort: 4 } : r));
  const seen = [];
  events.addClient({ on() {} }, { writeHead() {}, flushHeaders() {}, write(s) { seen.push(s); } });
  const p = await app.call('PUT', '/api/settings/lob-cg-map', { rows });
  assert.equal(p.status, 200, p.text);
  assert.ok(db.prepare("SELECT count(*) n FROM people WHERE dataset_id = ? AND lob_cg = 'Legal Team'").get(ds).n > 0);
  assert.equal(db.prepare("SELECT count(*) n FROM people WHERE dataset_id = ? AND lob_cg = 'GBS - L&C'").get(ds).n, 0);
  assert.ok(db.prepare("SELECT count(*) n FROM rollup_org_month WHERE dataset_id = ? AND lob_cg = 'Legal Team'").get(ds).n > 0);
  assert.equal(db.prepare("SELECT count(*) n FROM rollup_org_month WHERE dataset_id = ? AND lob_cg = 'GBS - L&C'").get(ds).n, 0);
  assert.ok(seen.some((s) => s.includes('lob-cg-map')));
  const org = (await app.call('GET', '/api/organization?dim=lob_cg')).json;
  assert.ok(org.rows.some((r) => r.label === 'Legal Team'));
  // one sort value per label, duplicate pairs, missing label
  const twoSorts = rows.concat([{ job_function: 'X', u_lob_2: 'Y', lob_cg: 'Legal Team', lob_cg_sort: 99 }]);
  assert.equal((await app.call('PUT', '/api/settings/lob-cg-map', { rows: twoSorts })).status, 400);
  assert.equal((await app.call('PUT', '/api/settings/lob-cg-map', { rows: rows.concat([rows[0]]) })).status, 400);
  assert.equal((await app.call('PUT', '/api/settings/lob-cg-map', { rows: [{ job_function: 'a', u_lob_2: 'b', lob_cg: '', lob_cg_sort: 1 }] })).status, 400);
  // removing every row leaves people Unassigned
  const empty = await app.call('PUT', '/api/settings/lob-cg-map', { rows: [] });
  assert.equal(empty.status, 200);
  assert.equal(db.prepare("SELECT count(*) n FROM people WHERE dataset_id = ? AND lob_cg <> 'Unassigned'").get(ds).n, 0);
});
