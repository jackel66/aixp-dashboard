'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers');

const ctx = setup();
const datasets = require('../src/services/datasets');
const verifyEngine = require('../src/services/verify');
const fixture = require('../src/services/fixture');
const { seedFixture } = require('./seed');
const db = ctx.db.getDb();
test.after(() => teardown(ctx));

const BASE = { people: 300, months: 3, endDate: '2026-10-30', seed: 20261103, previous: true, promote: false };

function failing(run) {
  return Array.from(new Set(run.results.filter((r) => r.status === 'fail').map((r) => (r.platform ? `${r.check_id}:${r.platform}` : r.check_id)))).sort();
}

test('CHECKS lists the 15 contract checks in order with meaning text', () => {
  assert.deepEqual(verifyEngine.CHECKS.map((c) => c.id), [
    'freshness_per_platform', 'date_coverage_gaps', 'duplicate_grain_rows', 'people_key_unique_nonblank',
    'email_key_conflict', 'unmatched_usage', 'blank_lob_retained', 'lob_cg_label_split', 'region_unmatched_office',
    'unit_sanity', 'cowork_cumulative_snapshots', 'seat_spend_not_in_rows', 'platform_total_delta',
    'attribution_before_after', 'people_duplicate_lookup_growth',
  ]);
  const sev = Object.fromEntries(verifyEngine.CHECKS.map((c) => [c.id, c.severity]));
  assert.equal(sev.blank_lob_retained, 'info');
  assert.equal(sev.attribution_before_after, 'info');
  assert.equal(sev.unmatched_usage, 'warn');
  assert.equal(sev.freshness_per_platform, 'fail');
  for (const c of verifyEngine.CHECKS) {
    assert.ok(c.meaning.length > 40, c.id);
    assert.equal(typeof c.platformScoped, 'boolean');
  }
});

test('verdictOf: fail beats warn beats pass; info never moves it', () => {
  const v = verifyEngine.verdictOf;
  assert.equal(v([{ status: 'pass', severity: 'fail' }]), 'pass');
  assert.equal(v([{ status: 'fail', severity: 'info' }]), 'pass');
  assert.equal(v([{ status: 'fail', severity: 'warn' }, { status: 'pass', severity: 'fail' }]), 'warn');
  assert.equal(v([{ status: 'fail', severity: 'warn' }, { status: 'fail', severity: 'fail' }]), 'fail');
  assert.equal(v([{ status: 'skip', severity: 'fail' }]), 'pass');
});

test('clean profile passes every check', () => {
  const r = seedFixture({ ...BASE, profile: 'clean' });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(failing(r.run), []);
  const byId = (id) => r.run.results.filter((x) => x.check_id === id);
  assert.equal(byId('platform_total_delta').every((x) => x.status === 'pass'), true, 'delta ran against the previous dataset');
  assert.equal(byId('cowork_cumulative_snapshots')[0].status, 'pass');
  assert.equal(byId('blank_lob_retained')[0].status, 'pass');
  assert.equal(byId('attribution_before_after').every((x) => x.status === 'pass'), true);
  assert.equal(r.run.fail_count, 0);
  assert.equal(r.run.warn_count, 0);
});

test('defective profile fails exactly the contract checks', () => {
  const r = seedFixture({ ...BASE, profile: 'defective' });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(failing(r.run), [
    'duplicate_grain_rows:anthropic',
    'email_key_conflict',
    'freshness_per_platform:github',
    'lob_cg_label_split',
    'people_key_unique_nonblank',
    'region_unmatched_office',
    'seat_spend_not_in_rows:github',
    'unit_sanity:openai',
    'unmatched_usage:anthropic',
    'unmatched_usage:cowork',
    'unmatched_usage:github',
    'unmatched_usage:openai',
  ]);
  const sev = (id) => r.run.results.find((x) => x.check_id === id).severity;
  assert.equal(sev('unmatched_usage'), 'warn');
  assert.equal(sev('region_unmatched_office'), 'warn');
  assert.equal(sev('unit_sanity'), 'warn');
  assert.equal(r.run.results.filter((x) => x.check_id === 'platform_total_delta').every((x) => x.status === 'pass'), true);
  const stale = r.run.results.find((x) => x.check_id === 'freshness_per_platform' && x.platform === 'github');
  assert.match(stale.message, /GitHub Copilot/);
  assert.match(stale.message, /overall maximum/);
});

// Each flag on its own fails only its own check(s).
const SINGLE = {
  stalePlatform: ['freshness_per_platform:github'],
  duplicates: ['duplicate_grain_rows:anthropic'],
  unmatchedKeys: ['unmatched_usage:anthropic', 'unmatched_usage:cowork', 'unmatched_usage:github', 'unmatched_usage:openai'],
  splitLob: ['lob_cg_label_split'],
  blankLob: [],
  emailConflict: ['email_key_conflict'],
  regionUnmatched: ['region_unmatched_office'],
  unitSwap: ['unit_sanity:openai'],
  seatRepeat: ['seat_spend_not_in_rows:github'],
  nbspKeys: ['people_key_unique_nonblank'],
  truncatedLobLabel: [],
};

test('SINGLE covers every defect flag', () => {
  assert.deepEqual(Object.keys(SINGLE).sort(), fixture.DEFECT_KEYS.slice().sort());
});

for (const [flag, expected] of Object.entries(SINGLE)) {
  test(`flag ${flag} alone fails only its own check`, () => {
    const r = seedFixture({ ...BASE, profile: 'clean', defects: { [flag]: true } });
    assert.deepEqual(failing(r.run), expected.slice().sort());
    const want = expected.length === 0 ? 'pass' : null;
    if (want) assert.equal(r.verdict, want);
  });
}

test('flags that must stay quiet keep their info checks passing', () => {
  const r = seedFixture({ ...BASE, profile: 'clean', defects: { blankLob: true } });
  const blank = r.run.results.find((x) => x.check_id === 'blank_lob_retained');
  assert.equal(blank.status, 'pass');
  assert.equal(blank.metrics.people, 12);
  assert.equal(blank.evidence.rows.length, 12);
});

test('delta is skipped when there is no previous dataset', () => {
  const r = seedFixture({ people: 60, months: 2, endDate: '2026-10-30', profile: 'clean', previous: false, compareTo: null, promote: false });
  const d = r.run.results.filter((x) => x.check_id === 'platform_total_delta');
  assert.equal(d.length, 4);
  assert.equal(d.every((x) => x.status === 'skip'), true);
});

test('delta fails when a platform moves more than the threshold', () => {
  const r = seedFixture({ ...BASE, profile: 'clean', previous: true, promote: false, label: 'delta' });
  db.prepare("DELETE FROM usage WHERE dataset_id = ? AND platform = 'openai' AND date < '2026-10-01' AND rowid % 2 = 0").run(r.datasetId);
  const run = datasets.verify(r.datasetId, { compareTo: r.previousId });
  const fails = run.results.filter((x) => x.check_id === 'platform_total_delta' && x.status === 'fail');
  assert.deepEqual(fails.map((x) => x.platform), ['openai']);
  assert.equal(run.verdict, 'warn');
});

test('date coverage warns when weekdays are missing', () => {
  const r = seedFixture({ ...BASE, profile: 'clean', previous: false, promote: false, label: 'gaps' });
  db.prepare("DELETE FROM stage_usage WHERE dataset_id = ? AND platform = 'Anthropic' AND date BETWEEN '2026-09-14' AND '2026-09-18'").run(r.datasetId);
  const run = datasets.verify(r.datasetId, { compareTo: null });
  const bad = run.results.filter((x) => x.check_id === 'date_coverage_gaps' && x.status === 'fail');
  assert.deepEqual(bad.map((x) => x.platform), ['anthropic']);
  assert.equal(bad[0].metrics.missingDays, 5);
  assert.equal(run.verdict, 'warn');
});

test('every check result carries the evidence shape and respects the 50 row cap', () => {
  const r = seedFixture({ ...BASE, profile: 'defective', label: 'shape' });
  for (const x of r.run.results) {
    assert.ok(Array.isArray(x.evidence.columns), x.check_id);
    assert.ok(Array.isArray(x.evidence.rows) && x.evidence.rows.length <= 50, x.check_id);
    assert.equal(typeof x.evidence.total, 'number', x.check_id);
    assert.equal(typeof x.metrics, 'object');
    assert.ok(x.message.length > 0);
  }
  const dup = r.run.results.find((x) => x.check_id === 'duplicate_grain_rows' && x.platform === 'anthropic');
  assert.equal(dup.evidence.rows.length, 50);
  assert.equal(dup.evidence.total, 200);
  assert.equal(dup.affected, 200);
});

test('evidence is ASCII only even when keys carry non-breaking spaces', () => {
  const r = seedFixture({ ...BASE, profile: 'clean', defects: { nbspKeys: true }, label: 'ascii' });
  const text = JSON.stringify(r.run.results.map((x) => [x.message, x.evidence]));
  assert.equal(/[^\x20-\x7e]/.test(text), false);
});
