'use strict';
const { addDays } = require('../time');
const { registerFunctions } = require('../normalize');
const { evidence, pass, fail, skip, platformName, PLATFORMS } = require('./util');

function dow(d) {
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay();
}

module.exports = {
  id: 'date_coverage_gaps',
  title: 'No gaps in date coverage',
  severity: 'warn',
  platformScoped: true,
  meaning:
    'Between a platform\'s first and last reporting date every calendar day should have rows. Weekend days only count ' +
    'when the platform reports on weekends. Cowork is judged on its snapshot dates, not on the one row kept per month.',
  run(ctx) {
    registerFunctions(ctx.db);
    // Raw stage dates, so Cowork is judged on every snapshot rather than the one kept per person and month.
    const rows = ctx.db
      .prepare(
        `SELECT aixp_platform(platform) AS p, aixp_date(date) AS d FROM stage_usage
         WHERE dataset_id = ? GROUP BY p, d HAVING p IS NOT NULL AND d IS NOT NULL`
      )
      .all(ctx.datasetId);
    const dates = {};
    for (const r of rows) (dates[r.p] = dates[r.p] || new Set()).add(r.d);
    const gapLimit = Number(ctx.settings['verify.gap_days'] === undefined ? 2 : ctx.settings['verify.gap_days']);
    const out = [];
    for (const p of PLATFORMS) {
      const set = dates[p.id];
      if (!set || !set.size) { out.push(skip(p.id, `${p.name} has no dated rows.`)); continue; }
      const sorted = Array.from(set).sort();
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      let weekend = false;
      for (const d of sorted) { const w = dow(d); if (w === 0 || w === 6) { weekend = true; break; } }
      const missing = [];
      for (let d = min; d <= max; d = addDays(d, 1)) {
        if (set.has(d)) continue;
        const w = dow(d);
        if (!weekend && (w === 0 || w === 6)) continue;
        missing.push(d);
      }
      const metrics = { from: min, to: max, daysWithRows: set.size, missingDays: missing.length, weekendRows: weekend, gapLimit };
      const ev = evidence(['missing_date'], missing.map((d) => [d]), missing.length);
      if (missing.length > gapLimit) {
        out.push(fail(p.id, `${platformName(p.id)} is missing ${missing.length} reporting days between ${min} and ${max} (limit ${gapLimit}).`, metrics, ev, missing.length));
      } else {
        out.push(pass(p.id, `${platformName(p.id)} covers ${min} to ${max} with ${missing.length} missing days.`, metrics, ev));
      }
    }
    return out;
  },
};
