'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
const db = ctx.db.getDb();
let app;
let seeded;

test.before(async () => {
  // default fixture size on purpose: the timing loop below needs realistic volume
  seeded = seedFixture({ previous: true, profile: 'defective', endDate: '2026-10-30', label: 'default size' });
  app = await startApp();
  app.call = (await app.admin()).call; // signed in as admin / M0nkside
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

const keys = (o) => Object.keys(o).sort();
const dsId = () => db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;

test('every route answers with the contract keys', async () => {
  const get = async (u) => {
    const r = await app.call('GET', u);
    assert.equal(r.status, 200, `${u}: ${r.text.slice(0, 200)}`);
    return r.json;
  };
  const s = await get('/api/summary');
  for (const k of ['asOf', 'dataset', 'range', 'headline', 'platforms', 'totals', 'confidence', 'caveat']) assert.ok(k in s, `summary.${k}`);
  assert.deepEqual(keys(s.headline), ['period', 'prior', 'spend']);
  assert.deepEqual(keys(s.headline.spend), ['consumption', 'seat', 'total']);
  assert.equal(s.platforms.length, 4);
  for (const p of s.platforms) {
    for (const k of ['id', 'name', 'unit', 'as_of', 'lag_days', 'stale', 'rows', 'spend', 'consumption', 'active_users', 'models_supported', 'spark']) assert.ok(k in p, `platform.${k}`);
    assert.equal(p.spark.length, 30);
    assert.ok(['tokens', 'credits'].includes(p.consumption.unit));
  }
  assert.equal(s.confidence.verdict, 'fail');
  assert.ok(s.confidence.first_failing && s.confidence.first_failing.id);
  assert.ok(s.caveat.startsWith('This dashboard provides a directional view'));

  const t = await get('/api/trend?grain=week');
  assert.deepEqual(keys(t), ['asOf', 'basis', 'buckets', 'from', 'grain', 'to']);
  assert.deepEqual(keys(t.buckets[0]), ['active_users', 'label', 'platforms', 'start', 'total_usd']);
  assert.deepEqual(keys(t.buckets[0].platforms.anthropic), ['active_users', 'consumption', 'usd']);

  const p = await get('/api/platforms/github');
  for (const k of ['asOf', 'platform', 'as_of', 'lag_days', 'stale', 'coverage', 'spend', 'prior', 'consumption', 'active_users', 'spend_per_unit', 'github', 'cowork', 'trend', 'models', 'top_users', 'checks']) assert.ok(k in p, `platformReport.${k}`);
  assert.equal(p.stale, true);
  assert.deepEqual(keys(p.github), ['discount', 'gross', 'net']);
  assert.equal(p.cowork, null);
  assert.deepEqual(p.models, []);
  assert.equal(p.spend_per_unit.valid, false);
  assert.ok(p.checks.some((c) => c.id === 'freshness_per_platform' && c.status === 'fail'));
  const cw = await get('/api/platforms/cowork');
  assert.equal(cw.cowork.rate, 0.008);
  assert.equal(cw.cowork.confirmed, false);
  assert.equal(cw.github, null);
  const an = await get('/api/platforms/anthropic');
  assert.equal(an.spend_per_unit.valid, true);
  assert.ok(an.models.length === 3 && an.models[0].share > 0);

  const o = await get('/api/organization?dim=lob_cg');
  assert.deepEqual(keys(o), ['asOf', 'basis', 'dim', 'measure', 'rows', 'scope', 'totals']);
  const cell = await get(`/api/organization/cell?dim=lob_cg&key=${encodeURIComponent(o.rows[0].key)}&platform=anthropic`);
  assert.deepEqual(keys(cell), ['contributors', 'share_of_column', 'share_of_row', 'total']);
  assert.ok(cell.contributors.length > 0 && cell.contributors.length <= 5);

  const m = await get('/api/models');
  assert.ok(m.rows.length >= 6);
  assert.deepEqual(keys(m.rows[0]), ['consumption', 'cost_per_unit', 'model', 'platform', 'requests', 'share', 'usd', 'users']);
  const md = await get(`/api/models/${m.rows[0].platform}/${m.rows[0].model}`);
  assert.equal(md.trend.length, 12);
  assert.ok(md.top_users.length > 0);

  const u = await get('/api/users?pageSize=5');
  assert.equal(u.rows.length, 5);
  assert.deepEqual(keys(u.rows[0]), ['active_days', 'display_name', 'lob_cg', 'matched', 'person_key', 'person_type', 'platforms', 'region', 'sbl', 'usd']);
  const ud = await get(`/api/users/${encodeURIComponent(u.rows[0].person_key)}`);
  assert.deepEqual(keys(ud), ['activity', 'asOf', 'models', 'person', 'platforms', 'spend', 'trend']);
  assert.ok(ud.trend.length === 90 && ud.activity.length <= 50);

  const v = await get('/api/verification');
  assert.ok(v.run.id && v.checks.length >= 15);
  const one = v.checks.find((c) => c.id === 'freshness_per_platform' && c.platform === 'github');
  const det = await get(`/api/verification/runs/${v.run.id}/checks/freshness_per_platform?platform=github`);
  assert.ok(det.evidence && Array.isArray(det.history) && det.status === one.status);
  const run = await get(`/api/verification/runs/${v.run.id}`);
  assert.ok(run.checks[0].evidence);

  const d = await get('/api/datasets');
  assert.equal(d.active_id, dsId());
  assert.equal(d.rows.length, 2);
  assert.equal((await get(`/api/datasets/${d.active_id}`)).id, d.active_id);
  const se = await get('/api/settings');
  assert.equal(se['cowork.rate'], 0.008);
});

test('basis math: total = consumption + seat, seat prorated, spend equals usage sums', async () => {
  const s = (await app.call('GET', '/api/summary?from=2026-09-01&to=2026-09-30')).json;
  const id = dsId();
  const c = db.prepare("SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND date BETWEEN '2026-09-01' AND '2026-09-30'").get(id).c;
  assert.ok(Math.abs(s.totals.spend.consumption.usd - c) < 0.05);
  const seat = db.prepare("SELECT sum(rate_usd * licensed_seats) s FROM seat_rate WHERE dataset_id = ? AND month = '2026-09'").get(id).s;
  assert.ok(Math.abs(s.totals.spend.seat.usd - seat) < 0.05, `${s.totals.spend.seat.usd} vs ${seat}`);
  assert.ok(Math.abs(s.totals.spend.total.usd - (s.totals.spend.consumption.usd + s.totals.spend.seat.usd)) < 0.02);
  const t = (await app.call('GET', '/api/trend?grain=day&from=2026-09-01&to=2026-09-30')).json;
  const sum = t.buckets.reduce((a, b) => a + b.total_usd, 0);
  assert.ok(Math.abs(sum - c) < 1, `trend ${sum} vs ${c}`);
  const ts = (await app.call('GET', '/api/trend?grain=month&from=2026-09-01&to=2026-09-30&basis=total')).json;
  assert.ok(Math.abs(ts.buckets[0].total_usd - (c + seat)) < 1);
  const tseat = (await app.call('GET', '/api/trend?grain=month&from=2026-09-01&to=2026-09-30&basis=seat')).json;
  assert.ok(Math.abs(tseat.buckets[0].total_usd - seat) < 1);
  const all = (await app.call('GET', '/api/trend?grain=month&from=2025-01-01&to=2027-01-01')).json;
  const total = db.prepare('SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ?').get(id).c;
  assert.ok(Math.abs(all.buckets.reduce((a, b) => a + b.total_usd, 0) - total) < 2);
});

test('units are never merged across platforms', async () => {
  const s = (await app.call('GET', '/api/summary')).json;
  for (const p of s.platforms) assert.equal(p.consumption.unit, p.id === 'anthropic' || p.id === 'openai' ? 'tokens' : 'credits');
  assert.equal(s.totals.consumption, undefined);
  const o = (await app.call('GET', '/api/organization?dim=region')).json;
  assert.equal(o.totals.total.consumption, undefined);
  for (const r of o.rows) assert.equal(r.total.consumption, undefined);
  const t = (await app.call('GET', '/api/trend?grain=week')).json;
  assert.equal(t.buckets[0].consumption, undefined);
});

test('organization: unassigned and unmatched rows, unmatched last, totals tie to summary', async () => {
  for (const dim of ['lob_cg', 'region', 'sbl', 'person_type']) {
    const o = (await app.call('GET', `/api/organization?dim=${dim}`)).json;
    const ks = o.rows.map((r) => r.key);
    assert.ok(ks.includes('__unassigned__'), dim);
    assert.equal(ks[ks.length - 1], '__unmatched__', dim);
    assert.equal(o.rows[ks.length - 1].label, 'Unmatched usage');
  }
  const o = (await app.call('GET', '/api/organization?dim=lob_cg')).json;
  const s = (await app.call('GET', '/api/summary')).json;
  assert.ok(Math.abs(o.totals.total.usd - s.totals.spend.consumption.usd) < 0.05);
  const un = o.rows.find((r) => r.key === '__unmatched__');
  assert.ok(un.total.usd > 0, 'defective fixture has unmatched spend');
  const rowSum = o.rows.reduce((a, r) => a + r.total.usd, 0);
  assert.ok(Math.abs(rowSum - o.totals.total.usd) < 0.1);
  const seat = (await app.call('GET', '/api/organization?dim=lob_cg&basis=seat')).json;
  assert.ok(Math.abs(seat.totals.total.usd - s.totals.spend.seat.usd) < 0.5, `${seat.totals.total.usd} vs ${s.totals.spend.seat.usd}`);
  const cellUn = (await app.call('GET', '/api/organization/cell?dim=lob_cg&key=__unmatched__&platform=github')).json;
  assert.ok(cellUn.total.usd > 0);
});

test('users: paging, q search, sort, filters', async () => {
  const p1 = (await app.call('GET', '/api/users?pageSize=10&page=1')).json;
  const p2 = (await app.call('GET', '/api/users?pageSize=10&page=2')).json;
  assert.equal(p1.rows.length, 10);
  assert.notEqual(p1.rows[0].person_key, p2.rows[0].person_key);
  assert.ok(p1.total > 100);
  for (let i = 1; i < p1.rows.length; i += 1) assert.ok(p1.rows[i - 1].usd >= p1.rows[i].usd);
  const first = p1.rows[0];
  const byKey = (await app.call('GET', `/api/users?q=${encodeURIComponent(first.person_key.toUpperCase())}`)).json;
  assert.ok(byKey.rows.some((r) => r.person_key === first.person_key));
  const byName = (await app.call('GET', `/api/users?q=${encodeURIComponent(first.display_name.split(' ')[0].toLowerCase())}`)).json;
  assert.ok(byName.rows.length >= 1 && byName.total <= p1.total);
  const nm = (await app.call('GET', '/api/users?sort=name&pageSize=20')).json;
  const names = nm.rows.map((r) => r.display_name.toLowerCase());
  assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
  const lob = first.lob_cg;
  const f = (await app.call('GET', `/api/users?lob_cg=${encodeURIComponent(lob)}&pageSize=200`)).json;
  assert.ok(f.rows.length > 0 && f.rows.every((r) => r.lob_cg === lob));
  const pt = (await app.call('GET', '/api/users?person_type=Associate&sbl=Client%20Services&pageSize=200')).json;
  assert.ok(pt.rows.length > 0 && pt.rows.every((r) => r.person_type === 'Associate' && r.sbl === 'Client Services'));
  const gh = (await app.call('GET', '/api/users?platform=github&pageSize=5')).json;
  assert.ok(gh.rows.every((r) => Object.keys(r.platforms).join() === 'github'));
  const none = (await app.call('GET', '/api/users?q=zzzzzzqq')).json;
  assert.equal(none.total, 0);
  assert.equal((await app.call('GET', '/api/users/nobody-here-xyz')).status, 404);
});

test('400 on bad params and 404 JSON on unknown API paths', async () => {
  for (const u of [
    '/api/summary?from=2026-13-01', '/api/summary?from=2026-10-10&to=2026-10-01', '/api/summary?platform=nope',
    '/api/summary?basis=weird', '/api/trend?grain=year', '/api/organization?dim=colour', '/api/organization?measure=x',
    '/api/users?pageSize=500', '/api/users?sort=bogus', '/api/users?page=0', '/api/organization/cell?dim=lob_cg&platform=anthropic',
  ]) {
    const r = await app.call('GET', u);
    assert.equal(r.status, 400, u);
    assert.ok(r.json && r.json.error, u);
  }
  assert.equal((await app.call('GET', '/api/platforms/nope')).status, 404);
  const r = await app.call('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.json.error.includes('No such API route'));
});

test('every GET answers under 200 ms warm on the default fixture', async () => {
  const g = (await app.call('GET', '/api/users?pageSize=1')).json.rows[0].person_key;
  const paths = [
    '/api/summary', '/api/summary?from=2026-01-01&to=2026-10-30', '/api/trend?grain=day', '/api/trend?grain=week',
    '/api/trend?grain=month&from=2025-12-01&to=2026-10-30', '/api/trend?grain=week&basis=total',
    '/api/platforms/anthropic', '/api/platforms/github', '/api/platforms/cowork',
    '/api/organization?dim=lob_cg', '/api/organization?dim=region&basis=total', '/api/organization?dim=sbl',
    '/api/organization?dim=person_type', '/api/organization/cell?dim=lob_cg&key=edo&platform=anthropic',
    '/api/models', '/api/models/anthropic/claude-sonnet-4-5',
    '/api/users?sort=usd&pageSize=10', '/api/users?q=a', '/api/users?sort=name&dir=asc&pageSize=50', `/api/users/${g}`,
    '/api/verification', '/api/datasets', '/api/settings', '/api/settings/seat-rates', '/api/settings/lob-cg-map',
    '/api/export/summary.csv', '/api/export/models.csv',
  ];
  const slow = [];
  for (const p of paths) {
    await app.call('GET', p);
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = process.hrtime.bigint();
      const r = await app.call('GET', p);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(r.status === 200 || r.status === 404, `${p} ${r.status}`);
      best = Math.min(best, ms);
    }
    console.log(`# ${best.toFixed(1).padStart(7)} ms  ${p}`);
    if (best > 200) slow.push(`${p} ${best.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, []);
});

test('verification and datasets actions, fixtures generate (runs last: changes the active dataset)', async () => {
  const d = (await app.call('GET', '/api/datasets')).json;
  const archived = d.rows.find((r) => r.status === 'archived');
  const ver = await app.call('POST', `/api/datasets/${archived.id}/verify`, {});
  assert.equal(ver.status, 200);
  assert.ok(ver.json.id && ver.json.verdict);
  const rb = await app.call('POST', '/api/datasets/rollback', { to: archived.id });
  assert.equal(rb.status, 200);
  assert.equal((await app.call('GET', '/api/datasets')).json.active_id, archived.id);
  assert.equal((await app.call('POST', '/api/datasets/rollback', { to: 9999 })).status, 404);
  const back = await app.call('POST', `/api/datasets/${seeded.datasetId}/promote`, { force: true });
  assert.equal(back.status, 200);
  assert.equal((await app.call('GET', '/api/summary')).json.dataset.id, seeded.datasetId);

  const r = await app.call('POST', '/api/fixtures/generate', { seed: 77, months: 2, people: 40, profile: 'clean', promote: true });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.dataset_id && r.json.promoted === true && r.json.verdict);
  assert.equal((await app.call('GET', '/api/datasets')).json.active_id, r.json.dataset_id);
  assert.equal((await app.call('POST', '/api/fixtures/generate', { profile: 'weird' })).status, 400);
  assert.equal((await app.call('GET', '/api/settings')).json['fixture.options'].seed, 77);
});
