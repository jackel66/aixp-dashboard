'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../src/services/fixture');
const { PLATFORMS } = require('../src/platforms');

const BASE = { seed: 7, months: 3, people: 60, endDate: '2026-10-30' };

test('same seed and options give identical output', () => {
  const a = fixture.generate({ ...BASE, profile: 'defective' });
  const b = fixture.generate({ ...BASE, profile: 'defective' });
  assert.deepEqual(a, b);
});

test('a different seed changes the output', () => {
  const a = fixture.generate({ ...BASE });
  const b = fixture.generate({ ...BASE, seed: 8 });
  assert.notDeepEqual(a.usage.slice(0, 50), b.usage.slice(0, 50));
});

test('output uses primer column names and covers every platform', () => {
  const fx = fixture.generate({ ...BASE });
  const cols = ['Date', 'PersonKey', 'Platform', 'Model', 'Tokens', 'Credits', 'Consumption', 'ConsumptionUnit',
    'CostUSD', 'requests', 'discount_amount', 'net_amount', 'email'];
  assert.deepEqual(Object.keys(fx.usage[0]), cols);
  assert.deepEqual(Object.keys(fx.people[0]),
    ['PersonKey', 'email', 'User ID', 'DisplayName', 'u_lob_2', 'job_function', 'OfficeCode', 'u_bo_fier_sbl', 'u_cg_person_type_code', 'ExtractAsOf']);
  assert.deepEqual(Object.keys(fx.seatRate[0]), ['Platform', 'Month', 'RateUSD', 'LicensedSeats']);
  assert.deepEqual(Object.keys(fx.regionMap[0]), ['OfficeCode', 'Region']);
  assert.deepEqual(Object.keys(fx.lobCgMap[0]), ['job_function', 'u_lob_2', 'LOB-CG', 'LOB-CG Sort']);
  const names = new Set(fx.usage.map((r) => r.Platform));
  for (const p of PLATFORMS) assert.ok(names.has(p.name), `missing ${p.name}`);
  assert.equal(fx.regionMap.length, 12);
  assert.equal(fx.seatRate.length, PLATFORMS.length * 3);
});

test('clean profile has no defect flags; defective has all', () => {
  const clean = fixture.generate({ ...BASE, profile: 'clean' });
  const bad = fixture.generate({ ...BASE, profile: 'defective' });
  for (const k of fixture.DEFECT_KEYS) {
    assert.equal(clean.meta.defects[k], false, k);
    assert.equal(bad.meta.defects[k], true, k);
  }
});

test('dates are YYYY-MM-DD, weekdays only, and end on or before endDate', () => {
  const fx = fixture.generate({ ...BASE });
  for (const r of fx.usage) {
    assert.match(r.Date, /^\d{4}-\d{2}-\d{2}$/);
    const wd = new Date(`${r.Date}T00:00:00Z`).getUTCDay();
    assert.ok(wd >= 1 && wd <= 5, r.Date);
    assert.ok(r.Date <= BASE.endDate);
  }
});

test('a shorter run ending on the same date reproduces the overlapping months', () => {
  const long = fixture.generate({ ...BASE, months: 3 });
  const short = fixture.generate({ ...BASE, months: 2 });
  const from = '2026-09-01';
  const key = (r) => JSON.stringify(r);
  const a = long.usage.filter((r) => r.Date >= from).map(key);
  const b = short.usage.filter((r) => r.Date >= from).map(key);
  assert.deepEqual(a, b);
});

test('cowork rows are cumulative per person and month, never decreasing', () => {
  const fx = fixture.generate({ ...BASE, people: 120 });
  const last = new Map();
  for (const r of fx.usage.filter((x) => x.Platform === 'Copilot Cowork')) {
    const k = `${r.PersonKey}|${r.Date.slice(0, 7)}`;
    if (last.has(k)) {
      assert.ok(r.Credits >= last.get(k), k);
    }
    last.set(k, r.Credits);
  }
  assert.ok(last.size > 20);
});

test('defects: duplicates, nbsp keys and the split label appear only when on', () => {
  const clean = fixture.generate({ ...BASE, people: 120, profile: 'clean' });
  const bad = fixture.generate({ ...BASE, people: 120, profile: 'defective' });
  assert.equal(clean.usage.some((r) => r.PersonKey.includes('\u00a0')), false);
  assert.equal(bad.usage.some((r) => r.PersonKey.includes('\u00a0')), true);
  assert.equal(clean.lobCgMap.filter((r) => r['LOB-CG'] === 'GBS - L&C').length, 2);
  assert.equal(bad.lobCgMap.filter((r) => r['LOB-CG'] === 'GBS - L&C').length, 3);
  assert.equal(clean.people.some((r) => r.OfficeCode === 'ZZ9'), false);
  assert.equal(bad.people.some((r) => r.OfficeCode === 'ZZ9'), true);
  assert.equal(bad.meta.ghosts, 15);
});

test('single defect flag overrides the profile', () => {
  const fx = fixture.generate({ ...BASE, profile: 'clean', defects: { regionUnmatched: true } });
  assert.equal(fx.meta.defects.regionUnmatched, true);
  assert.equal(fx.meta.defects.duplicates, false);
});
