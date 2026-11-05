'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
let app;
let ids = [];

test.before(async () => {
  // default fixture size on purpose: the timing loop needs realistic volume
  seedFixture({ previous: true, profile: 'defective', endDate: '2026-10-30', label: 'reports catalogue' });
  app = await startApp();
  app.call = (await app.admin()).call; // signed in as admin / M0nkside
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

const TYPES = ['text', 'money', 'number', 'units', 'pct', 'date', 'platform', 'delta'];

test('GET /api/reports lists 17 reports in four groups', async () => {
  const r = await app.call('GET', '/api/reports');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.groups.map((g) => g.id), ['users', 'platforms', 'models', 'costs']);
  assert.equal(r.json.reports.length, 17);
  ids = r.json.reports.map((x) => x.id);
  assert.equal(new Set(ids).size, 17);
  for (const rep of r.json.reports) {
    assert.ok(r.json.groups.some((g) => g.id === rep.group), rep.id);
    assert.ok(rep.title && rep.description && Array.isArray(rep.params) && rep.columns.length > 0, rep.id);
    for (const c of rep.columns) {
      assert.ok(c.key && c.label && TYPES.includes(c.type), `${rep.id}.${c.key}`);
    }
  }
});

function checkShape(cat, j, label) {
  assert.equal(j.id, cat.id, label);
  for (const k of ['title', 'description', 'asOf', 'range', 'params', 'columns', 'rows', 'totals', 'chart', 'notes']) assert.ok(k in j, `${label} has ${k}`);
  const keys = j.columns.map((c) => c.key);
  for (const c of cat.columns) assert.ok(keys.includes(c.key), `${label}: catalogue column ${c.key} present in response`);
  for (const row of j.rows) {
    for (const c of j.columns) {
      assert.ok(row[c.key] !== undefined, `${label}: row lacks ${c.key}`);
      if (c.type === 'units' && row[c.key] !== null) assert.deepEqual(Object.keys(row[c.key]).sort(), ['unit', 'value'], `${label}.${c.key}`);
      if (c.type === 'delta' && row[c.key] !== null) assert.deepEqual(Object.keys(row[c.key]).sort(), ['delta', 'now', 'pct', 'prev'], `${label}.${c.key}`);
    }
  }
  if (j.chart) {
    assert.ok(['bar', 'line', 'stacked'].includes(j.chart.type), label);
    assert.ok(Array.isArray(j.chart.labels) && Array.isArray(j.chart.series), label);
    for (const s of j.chart.series) assert.equal(s.data.length, j.chart.labels.length, `${label}: series ${s.label}`);
  }
}

test('every report answers 200 with its declared columns on every row', async () => {
  const cat = (await app.call('GET', '/api/reports')).json.reports;
  for (const rep of cat) {
    const r = await app.call('GET', `/api/reports/${rep.id}`);
    assert.equal(r.status, 200, `${rep.id}: ${r.text.slice(0, 200)}`);
    checkShape(rep, r.json, rep.id);
  }
});

test('a one-day range (from == to == asOf) works on every report and on the core routes', async () => {
  const cat = (await app.call('GET', '/api/reports')).json.reports;
  const asOf = (await app.call('GET', '/api/summary')).json.asOf;
  const q = `from=${asOf}&to=${asOf}`;
  for (const rep of cat) {
    const r = await app.call('GET', `/api/reports/${rep.id}?${q}`);
    assert.equal(r.status, 200, `${rep.id}: ${r.text.slice(0, 200)}`);
    checkShape(rep, r.json, `${rep.id} one day`);
    if (rep.params.includes('range')) assert.deepEqual(r.json.range, { from: asOf, to: asOf }, rep.id);
  }
  for (const u of [
    `/api/summary?${q}`, `/api/trend?grain=day&${q}`, `/api/trend?grain=week&${q}`, `/api/platforms/github?${q}`,
    `/api/organization?dim=lob_cg&${q}`, `/api/models?${q}`, `/api/users?${q}`, `/api/organization?dim=region&basis=total&${q}`,
  ]) {
    const r = await app.call('GET', u);
    assert.equal(r.status, 200, `${u}: ${r.text.slice(0, 200)}`);
  }
  const t = (await app.call('GET', `/api/trend?grain=day&${q}`)).json;
  assert.equal(t.buckets.length, 1);
  assert.equal(t.buckets[0].start, asOf);
});

test('users_new, users_inactive and costs_movers return rows on the default fixture; reports are consistent', async () => {
  for (const id of ['users_new', 'users_inactive', 'costs_movers', 'users_top', 'models_cost', 'platforms_summary', 'costs_monthly']) {
    const r = await app.call('GET', `/api/reports/${id}`);
    assert.equal(r.status, 200, id);
    assert.ok(r.json.rows.length > 0, `${id} has rows`);
  }
  const top = (await app.call('GET', '/api/reports/users_top?limit=5')).json;
  assert.equal(top.rows.length, 5);
  assert.equal(top.rows[0].rank, 1);
  for (let i = 1; i < top.rows.length; i += 1) assert.ok(top.rows[i - 1].usd >= top.rows[i].usd);
  assert.ok(top.rows[0].share > 0 && top.rows[0].share < 100, 'share is a percent number');
  const sum = (await app.call('GET', '/api/summary')).json;
  const ps = (await app.call('GET', '/api/reports/platforms_summary')).json;
  assert.equal(ps.rows.length, 5);
  const consTotal = ps.rows.reduce((a, r) => a + r.consumption_usd, 0);
  assert.ok(Math.abs(consTotal - sum.totals.spend.consumption.usd) < 0.1, `${consTotal} vs ${sum.totals.spend.consumption.usd}`);
  for (const r of ps.rows) assert.ok(['tokens', 'credits'].includes(r.consumption.unit));
  const pm = (await app.call('GET', '/api/reports/platforms_monthly?basis=total')).json;
  assert.ok(pm.rows.every((r) => Math.abs(r.total - ['anthropic', 'openai', 'github', 'cowork', 'bedrock'].reduce((a, i) => a + r[`usd_${i}`], 0)) < 0.05));
  const gh = (await app.call('GET', '/api/reports/users_top?platform=github&limit=3')).json;
  assert.deepEqual(gh.params.platform, ['github']);
  assert.ok(gh.rows.every((r) => r.usd_anthropic === 0 && r.usd_openai === 0));
  const bg = (await app.call('GET', '/api/reports/users_by_group?dim=region')).json;
  assert.equal(bg.params.dim, 'region');
  assert.ok(bg.rows.length > 0);
  const mv = (await app.call('GET', '/api/reports/costs_movers')).json;
  for (let i = 1; i < mv.rows.length; i += 1) assert.ok(Math.abs(mv.rows[i - 1].delta.delta) >= Math.abs(mv.rows[i].delta.delta));
});

test('400 on bad params, 404 on an unknown report', async () => {
  for (const u of [
    '/api/reports/users_top?limit=0', '/api/reports/users_top?limit=501', '/api/reports/users_top?limit=abc',
    '/api/reports/users_by_group?dim=colour', '/api/reports/users_top?platform=nope', '/api/reports/users_top?from=2026-13-01',
    '/api/reports/users_top?from=2026-10-10&to=2026-10-01', '/api/reports/platforms_summary?basis=weird',
  ]) {
    const r = await app.call('GET', u);
    assert.equal(r.status, 400, u);
    assert.ok(r.json && r.json.error, u);
  }
  assert.equal((await app.call('GET', '/api/reports/nope')).status, 404);
  assert.equal((await app.call('GET', '/api/export/report/nope.csv')).status, 404);
});

test('CSV export: caveat first line, units and delta flattened', async () => {
  const { CAVEAT } = require('../src/platforms');
  const r = await app.call('GET', '/api/export/report/platforms_summary.csv');
  assert.equal(r.status, 200);
  const lines = r.text.split('\r\n');
  assert.equal(lines[0], `# ${CAVEAT}`);
  const head = lines[1].split(',');
  assert.ok(head.includes('consumption') && head.includes('consumption_unit'));
  assert.equal(lines.filter(Boolean).length, 2 + 5);
  const m = await app.call('GET', '/api/export/report/costs_monthly.csv');
  assert.equal(m.status, 200);
  const mh = m.text.split('\r\n')[1].split(',');
  for (const k of ['delta_total_now', 'delta_total_prev', 'delta_total_delta', 'delta_total_pct']) assert.ok(mh.includes(k), k);
  for (const id of ids) {
    const c = await app.call('GET', `/api/export/report/${id}.csv`);
    assert.equal(c.status, 200, id);
    assert.ok(c.text.startsWith('# This dashboard provides a directional view'), id);
  }
});

test('every report answers under 300 ms warm on the default fixture', async () => {
  const slow = [];
  const asOf = (await app.call('GET', '/api/summary')).json.asOf;
  const variants = (id) => [`/api/reports/${id}`, `/api/reports/${id}?from=${asOf}&to=${asOf}`];
  for (const id of ids) {
    for (const p of variants(id)) {
      await app.call('GET', p);
      let best = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const t0 = process.hrtime.bigint();
        const r = await app.call('GET', p);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.equal(r.status, 200, p);
        best = Math.min(best, ms);
      }
      console.log(`# ${best.toFixed(1).padStart(7)} ms  ${p}`);
      if (best > 300) slow.push(`${p} ${best.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});
