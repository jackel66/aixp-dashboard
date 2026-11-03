'use strict';
const { evidence, pass, money } = require('./util');

module.exports = {
  id: 'blank_lob_retained',
  title: 'People with a blank LOB are retained',
  severity: 'info',
  platformScoped: false,
  meaning:
    'A missing u_lob_2 is a missing attribute, not a missing person. These people stay in People and their spend stays ' +
    'in organization views under Unassigned.',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT p.person_key, p.display_name, p.job_function, p.lob_cg,
           coalesce((SELECT round(sum(u.cost_usd), 2) FROM usage u WHERE u.dataset_id = p.dataset_id AND u.person_key = p.person_key), 0) AS cost
         FROM people p WHERE p.dataset_id = ? AND trim(coalesce(p.u_lob_2, '')) = '' ORDER BY cost DESC, p.person_key`
      )
      .all(ctx.datasetId);
    const spend = rows.reduce((a, r) => a + r.cost, 0);
    return pass(null,
      rows.length
        ? `${rows.length} people have a blank u_lob_2 and are retained as Unassigned; their spend of ${money(spend)} stays in totals.`
        : 'No people have a blank u_lob_2.',
      { people: rows.length, spendUsd: Math.round(spend * 100) / 100 },
      evidence(['person_key', 'display_name', 'job_function', 'lob_cg', 'cost_usd'],
        rows.map((r) => [r.person_key, r.display_name, r.job_function, r.lob_cg, r.cost]), rows.length));
  },
};
