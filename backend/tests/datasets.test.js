'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers');

const ctx = setup();
const datasets = require('../src/services/datasets');
const staging = require('../src/services/staging');
const { seedFixture } = require('./seed');
const db = ctx.db.getDb();
test.after(() => teardown(ctx));

const SMALL = { people: 80, months: 2, endDate: '2026-10-30', seed: 11 };

test('settings are seeded as JSON strings', () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cowork.rate'").get();
  assert.equal(row.value, '0.008');
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'verify.stale_days'").get().value), 5);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'lobcg.seed'").get().value).length > 5, true);
});

test('empty database: no active dataset, health summary is zeroed', () => {
  assert.equal(datasets.active(), null);
  const h = datasets.healthSummary();
  assert.equal(h.activeDatasetId, null);
  assert.equal(h.counts.usage_rows, 0);
});

test('seedFixture runs the whole path and activates a clean dataset', () => {
  const { datasetId, verdict } = seedFixture({ ...SMALL, profile: 'clean', label: 'first' });
  assert.equal(verdict, 'pass');
  const a = datasets.active();
  assert.equal(a.id, datasetId);
  assert.equal(a.status, 'active');
  assert.ok(a.promoted_at);
  assert.equal(a.platforms.length, 5);
  for (const p of a.platforms) assert.ok(p.rows > 0 && p.min_date && p.max_date && p.cost_usd > 0);
  const h = datasets.healthSummary();
  assert.equal(h.activeDatasetId, datasetId);
  assert.equal(h.counts.platforms, 5);
  assert.equal(h.counts.people, 80);
  assert.ok(h.counts.usage_rows > 1000);
});

test('promote archives the previous active dataset and keeps exactly one active', () => {
  const first = datasets.active().id;
  const { datasetId } = seedFixture({ ...SMALL, seed: 12, profile: 'clean', label: 'second' });
  assert.equal(datasets.active().id, datasetId);
  assert.equal(datasets.get(first).status, 'archived');
  assert.ok(datasets.get(first).archived_at);
  assert.equal(db.prepare("SELECT count(*) AS n FROM datasets WHERE status = 'active'").get().n, 1);
  assert.ok(datasets.list().length >= 2);
});

test('promote refuses a failing verdict without force and accepts it with force', () => {
  const { datasetId, verdict } = seedFixture({ ...SMALL, seed: 13, profile: 'defective', promote: false, label: 'bad' });
  assert.equal(verdict, 'fail');
  assert.throws(() => datasets.promote(datasetId), (e) => e.status === 409);
  assert.notEqual(datasets.active().id, datasetId);
  datasets.promote(datasetId, { force: true });
  assert.equal(datasets.active().id, datasetId);
});

test('promote refuses an unverified dataset', () => {
  const id = staging.createDataset({ label: 'raw' });
  assert.throws(() => datasets.promote(id, { force: true }), (e) => e.status === 409);
});

test('verify stores a run with results and evidence capped at 50 rows', () => {
  const id = datasets.active().id;
  const run = datasets.verify(id);
  assert.ok(run.id > 0);
  assert.equal(run.results.length > 15, true);
  for (const r of run.results) {
    assert.ok(['pass', 'fail', 'skip'].includes(r.status));
    assert.ok(r.evidence.rows.length <= 50);
    assert.ok(r.title && r.message);
  }
  const stored = db.prepare('SELECT count(*) AS n FROM verification_results WHERE run_id = ?').get(run.id).n;
  assert.equal(stored, run.results.length);
  assert.equal(datasets.get(id).verdict, run.verdict);
});

test('rollback re-promotes an archived dataset without re-verifying', () => {
  const cur = datasets.active().id;
  const archived = db.prepare("SELECT id FROM datasets WHERE status = 'archived' ORDER BY id LIMIT 1").get().id;
  const runsBefore = db.prepare('SELECT count(*) AS n FROM verification_runs').get().n;
  const back = datasets.rollback(archived);
  assert.equal(back.id, archived);
  assert.equal(datasets.active().id, archived);
  assert.equal(datasets.get(cur).status, 'archived');
  assert.equal(db.prepare('SELECT count(*) AS n FROM verification_runs').get().n, runsBefore);
  assert.throws(() => datasets.rollback(archived), (e) => e.status === 409);
  assert.throws(() => datasets.rollback(99999), (e) => e.status === 404);
});

test('file_hash is unique when set', () => {
  staging.createDataset({ label: 'a', source: 'import', file_hash: 'abc' });
  assert.throws(() => staging.createDataset({ label: 'b', source: 'import', file_hash: 'abc' }));
});

test('purge drops stage rows beyond datasets.keep and usage beyond the newest two archived', () => {
  for (let i = 0; i < 3; i++) seedFixture({ ...SMALL, seed: 20 + i, profile: 'clean', months: 1, people: 30, label: `p${i}` });
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'datasets.keep'").run();
  const out = datasets.purge();
  assert.ok(out.stagePurged.length >= 1);
  assert.ok(out.usagePurged.length >= 1);
  for (const id of out.usagePurged) {
    assert.equal(db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ?').get(id).n, 0);
  }
  for (const id of out.stagePurged) {
    assert.equal(db.prepare('SELECT count(*) AS n FROM stage_usage WHERE dataset_id = ?').get(id).n, 0);
  }
  assert.throws(() => datasets.rollback(out.usagePurged[0]), (e) => e.status === 409);
  assert.ok(db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ?').get(datasets.active().id).n > 0);
});
