'use strict';
// Verification engine: ordered checks, run(ctx), verdict.
const checks = [
  require('./freshness_per_platform'),
  require('./date_coverage_gaps'),
  require('./duplicate_grain_rows'),
  require('./people_key_unique_nonblank'),
  require('./email_key_conflict'),
  require('./unmatched_usage'),
  require('./blank_lob_retained'),
  require('./lob_cg_label_split'),
  require('./region_unmatched_office'),
  require('./unit_sanity'),
  require('./cowork_cumulative_snapshots'),
  require('./seat_spend_not_in_rows'),
  require('./platform_total_delta'),
  require('./attribution_before_after'),
  require('./people_duplicate_lookup_growth'),
];

const CHECKS = checks.map((c) => ({
  id: c.id, title: c.title, severity: c.severity, platformScoped: !!c.platformScoped, meaning: c.meaning,
}));

function verdictOf(results) {
  let warn = false;
  for (const r of results) {
    if (r.status !== 'fail') continue;
    if (r.severity === 'fail') return 'fail';
    if (r.severity === 'warn') warn = true;
  }
  return warn ? 'warn' : 'pass';
}

// ctx = {db, datasetId, prevDatasetId, settings, today}
function run(ctx) {
  const started = Date.now();
  const results = [];
  for (const c of checks) {
    let out;
    try {
      out = c.run(ctx);
    } catch (e) {
      out = [{
        status: 'fail', platform: null, message: `Check crashed: ${e.message}`, metrics: {},
        evidence: { columns: [], rows: [], total: 0 }, affected: 0,
      }];
    }
    for (const r of Array.isArray(out) ? out : [out]) {
      results.push({
        check_id: c.id, severity: c.severity, title: c.title, platformScoped: !!c.platformScoped, ...r,
      });
    }
  }
  const count = (fn) => results.filter(fn).length;
  return {
    ran_at: new Date().toISOString(),
    verdict: verdictOf(results),
    fail_count: count((r) => r.status === 'fail' && r.severity === 'fail'),
    warn_count: count((r) => r.status === 'fail' && r.severity === 'warn'),
    info_count: count((r) => r.severity === 'info'),
    pass_count: count((r) => r.status === 'pass' && r.severity !== 'info'),
    duration_ms: Date.now() - started,
    compared_to_dataset_id: ctx.prevDatasetId || null,
    results,
  };
}

module.exports = { CHECKS, run, verdictOf };
