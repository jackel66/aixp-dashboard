'use strict';
const { evidence, pass, fail, skip, platformName, vis, money, PLATFORMS } = require('./util');

module.exports = {
  id: 'unmatched_usage',
  title: 'Usage resolves to a known person',
  severity: 'warn',
  platformScoped: true,
  meaning:
    'Usage whose key is not in People stays in raw totals under a blank relationship member while named-user and ' +
    'organization views omit it. The unmatched share of cost should stay under the threshold.',
  run(ctx) {
    const limit = Number(ctx.settings['verify.unmatched_pct'] === undefined ? 2 : ctx.settings['verify.unmatched_pct']);
    const tot = {};
    for (const r of ctx.db
      .prepare(
        `SELECT platform, count(*) AS n, sum(cost_usd) AS cost,
           sum(CASE WHEN matched = 0 THEN 1 ELSE 0 END) AS un_rows,
           sum(CASE WHEN matched = 0 THEN cost_usd ELSE 0 END) AS un_cost,
           count(DISTINCT CASE WHEN matched = 0 THEN person_key END) AS un_keys
         FROM usage WHERE dataset_id = ? GROUP BY platform`
      )
      .all(ctx.datasetId)) tot[r.platform] = r;
    const out = [];
    for (const p of PLATFORMS) {
      const t = tot[p.id];
      if (!t) { out.push(skip(p.id, `${p.name} has no usage rows in this dataset.`)); continue; }
      const share = t.cost > 0 ? (100 * t.un_cost) / t.cost : 0;
      const metrics = {
        rawCost: Math.round(t.cost * 100) / 100,
        attributedCost: Math.round((t.cost - t.un_cost) * 100) / 100,
        unmatchedCost: Math.round(t.un_cost * 100) / 100,
        sharePct: Math.round(share * 100) / 100,
        unmatchedRows: t.un_rows,
        unmatchedKeys: t.un_keys,
        limitPct: limit,
      };
      const top = ctx.db
        .prepare(
          `SELECT person_key, count(*) AS n, round(sum(cost_usd), 2) AS cost FROM usage
           WHERE dataset_id = ? AND platform = ? AND matched = 0 GROUP BY person_key ORDER BY cost DESC, person_key LIMIT 50`
        )
        .all(ctx.datasetId, p.id);
      const ev = evidence(['person_key', 'rows', 'cost_usd'], top.map((x) => [vis(x.person_key), x.n, x.cost]), t.un_keys);
      if (share > limit) {
        out.push(fail(p.id,
          `${platformName(p.id)}: ${share.toFixed(1)} percent of cost (${money(t.un_cost)} of ${money(t.cost)}, ${t.un_keys} keys) has no matching person. Limit ${limit} percent.`,
          metrics, ev, t.un_rows));
      } else {
        out.push(pass(p.id, `${platformName(p.id)}: ${share.toFixed(1)} percent of cost is unmatched, inside the ${limit} percent limit.`, metrics, ev));
      }
    }
    return out;
  },
};
