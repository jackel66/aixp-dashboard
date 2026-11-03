'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
const rollups = require('../src/services/rollups');
const db = ctx.db.getDb();
test.after(() => teardown(ctx));

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

test('rollup sums equal usage sums per platform and dataset', () => {
  const { datasetId } = seedFixture({ people: 120, months: 3, endDate: '2026-10-30', seed: 5, profile: 'defective' });
  for (const t of ['rollup_platform_day', 'rollup_model_day', 'rollup_person_day', 'rollup_org_month']) {
    const rows = db.prepare(
      `SELECT r.platform, r.c AS rc, r.t AS rt, r.n AS rn, u.c AS uc, u.t AS ut, u.n AS un FROM
         (SELECT platform, sum(cost_usd) c, sum(tokens) t, sum(rows) n FROM ${t} WHERE dataset_id = ? GROUP BY platform) r
         JOIN (SELECT platform, sum(cost_usd) c, sum(tokens) t, count(*) n FROM usage WHERE dataset_id = ? GROUP BY platform) u
         ON u.platform = r.platform`
    ).all(datasetId, datasetId);
    assert.equal(rows.length, 4, t);
    for (const r of rows) {
      close(r.rc, r.uc, `${t} cost ${r.platform}`);
      close(r.rt, r.ut, `${t} tokens ${r.platform}`);
      assert.equal(r.rn, r.un, `${t} rows ${r.platform}`);
    }
  }
  const pm = db.prepare('SELECT platform, sum(cost_usd) c FROM rollup_person_month WHERE dataset_id = ? GROUP BY platform').all(datasetId);
  for (const r of pm) {
    close(r.c, db.prepare('SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND platform = ?').get(datasetId, r.platform).c, `person_month ${r.platform}`);
  }
});

test('no seat cost sits in rollup rows', () => {
  const ds = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;
  const seat = db.prepare('SELECT sum(rate_usd * licensed_seats) s FROM seat_rate WHERE dataset_id = ?').get(ds).s;
  assert.ok(seat > 0);
  const usage = db.prepare('SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ?').get(ds).c;
  const roll = db.prepare('SELECT sum(cost_usd) c FROM rollup_platform_day WHERE dataset_id = ?').get(ds).c;
  close(roll, usage, 'rollup equals usage, seat excluded');
  for (const t of ['rollup_platform_day', 'rollup_org_month']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /seat/.test(c)), `${t} has no seat column`);
  }
});

test('platform_day splits matched and unmatched cost; org rollup flags unmatched', () => {
  const ds = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;
  const r = db.prepare('SELECT sum(cost_usd) c, sum(matched_cost_usd) m, sum(unmatched_cost_usd) u FROM rollup_platform_day WHERE dataset_id = ?').get(ds);
  close(r.m + r.u, r.c, 'matched + unmatched');
  assert.ok(r.u > 0, 'defective profile has unmatched spend');
  const o = db.prepare('SELECT sum(cost_usd) c FROM rollup_org_month WHERE dataset_id = ? AND matched = 0').get(ds);
  close(o.c, r.u, 'org unmatched equals platform unmatched');
});

test('drop and rebuild are idempotent and rebuildOrg keeps totals', () => {
  const ds = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;
  const before = db.prepare('SELECT count(*) n, sum(cost_usd) c FROM rollup_org_month WHERE dataset_id = ?').get(ds);
  rollups.rebuildOrg(db, ds);
  const after = db.prepare('SELECT count(*) n, sum(cost_usd) c FROM rollup_org_month WHERE dataset_id = ?').get(ds);
  assert.deepEqual(after, before);
  const t0 = Date.now();
  rollups.build(db, ds);
  const ms = Date.now() - t0;
  console.log(`# rollups.build on this fixture: ${ms} ms`);
  const again = db.prepare('SELECT count(*) n, sum(cost_usd) c FROM rollup_org_month WHERE dataset_id = ?').get(ds);
  assert.deepEqual(again, before);
  rollups.drop(db, ds);
  assert.equal(db.prepare('SELECT count(*) n FROM rollup_person_day WHERE dataset_id = ?').get(ds).n, 0);
  rollups.build(db, ds);
});

test('active users count only people with activity', () => {
  const ds = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;
  const a = db.prepare(
    `SELECT sum(active_users) n FROM rollup_platform_day WHERE dataset_id = ? AND platform = 'anthropic'`
  ).get(ds).n;
  const b = db.prepare(
    `SELECT count(*) n FROM (SELECT DISTINCT date, person_key FROM usage WHERE dataset_id = ? AND platform = 'anthropic'
       AND (cost_usd > 0 OR tokens > 0 OR credits > 0))`
  ).get(ds).n;
  assert.equal(a, b);
});
