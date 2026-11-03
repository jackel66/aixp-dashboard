'use strict';
const { evidence, pass, fail, skip, platformName, PLATFORMS } = require('./util');

function monthly(db, id) {
  const out = {};
  for (const r of db
    .prepare('SELECT platform, substr(date, 1, 7) AS m, count(*) AS n, sum(cost_usd) AS cost, max(date) AS maxd FROM usage WHERE dataset_id = ? GROUP BY platform, m')
    .all(id)) {
    (out[r.platform] = out[r.platform] || {})[r.m] = r;
  }
  return out;
}

const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : 100) : (100 * Math.abs(a - b)) / Math.abs(b));

module.exports = {
  id: 'platform_total_delta',
  title: 'Platform totals are stable against the previous dataset',
  severity: 'warn',
  platformScoped: true,
  meaning:
    'Cost and row counts for the months both datasets cover should not move more than the threshold. The latest month ' +
    'of each platform is left out because it is still filling. A large move means a source change, a duplicate load or a gap.',
  run(ctx) {
    if (!ctx.prevDatasetId) return PLATFORMS.map((p) => skip(p.id, 'No previous dataset to compare against.'));
    const limit = Number(ctx.settings['verify.delta_pct'] === undefined ? 25 : ctx.settings['verify.delta_pct']);
    const cur = monthly(ctx.db, ctx.datasetId);
    const prev = monthly(ctx.db, ctx.prevDatasetId);
    const out = [];
    for (const p of PLATFORMS) {
      const c = cur[p.id];
      const q = prev[p.id];
      if (!c || !q) { out.push(skip(p.id, `${p.name} is missing from one of the datasets.`)); continue; }
      const lastC = Object.keys(c).sort().pop();
      const lastQ = Object.keys(q).sort().pop();
      const months = Object.keys(c).filter((m) => q[m] && m !== lastC && m !== lastQ).sort();
      if (!months.length) { out.push(skip(p.id, `${p.name} has no complete month in common with the previous dataset.`)); continue; }
      let cc = 0; let cn = 0; let qc = 0; let qn = 0;
      for (const m of months) { cc += c[m].cost; cn += c[m].n; qc += q[m].cost; qn += q[m].n; }
      const dCost = pct(cc, qc);
      const dRows = pct(cn, qn);
      const metrics = {
        months: months.length, costPct: Math.round(dCost * 100) / 100, rowsPct: Math.round(dRows * 100) / 100,
        cost: Math.round(cc * 100) / 100, prevCost: Math.round(qc * 100) / 100, rows: cn, prevRows: qn, limitPct: limit,
      };
      const ev = evidence(['month', 'cost_usd', 'previous_cost_usd', 'rows', 'previous_rows'],
        months.map((m) => [m, Math.round(c[m].cost * 100) / 100, Math.round(q[m].cost * 100) / 100, c[m].n, q[m].n]), months.length);
      if (dCost > limit || dRows > limit) {
        out.push(fail(p.id,
          `${platformName(p.id)} moved ${dCost.toFixed(1)} percent in cost and ${dRows.toFixed(1)} percent in rows against dataset ${ctx.prevDatasetId} over ${months.length} shared months. Limit ${limit} percent.`,
          metrics, ev, Math.abs(cn - qn)));
      } else {
        out.push(pass(p.id, `${platformName(p.id)} moved ${dCost.toFixed(1)} percent in cost and ${dRows.toFixed(1)} percent in rows over ${months.length} shared months.`, metrics, ev));
      }
    }
    return out;
  },
};
