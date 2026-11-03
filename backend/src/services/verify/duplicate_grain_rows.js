'use strict';
const { evidence, pass, fail, skip, platformName, vis, PLATFORMS } = require('./util');

module.exports = {
  id: 'duplicate_grain_rows',
  title: 'No duplicate rows at the usage grain',
  severity: 'fail',
  platformScoped: true,
  meaning:
    'Usage must be unique at date, person, platform and model. Repeated rows at that grain multiply spend, usually ' +
    'from a join that matched more than once or an extract loaded twice.',
  run(ctx) {
    const groups = ctx.db
      .prepare(
        `SELECT platform, date, person_key, model, count(*) AS c, round(sum(cost_usd), 4) AS cost
         FROM usage WHERE dataset_id = ? GROUP BY platform, date, person_key, model HAVING count(*) > 1`
      )
      .all(ctx.datasetId);
    const present = new Set(
      ctx.db.prepare('SELECT DISTINCT platform FROM usage WHERE dataset_id = ?').all(ctx.datasetId).map((r) => r.platform)
    );
    const out = [];
    for (const p of PLATFORMS) {
      if (!present.has(p.id)) { out.push(skip(p.id, `${p.name} has no usage rows in this dataset.`)); continue; }
      const g = groups.filter((x) => x.platform === p.id).sort((a, b) => b.c - a.c || b.cost - a.cost);
      const extraRows = g.reduce((a, x) => a + x.c - 1, 0);
      const extraCost = g.reduce((a, x) => a + x.cost * (x.c - 1) / x.c, 0);
      const metrics = { groups: g.length, extraRows, extraCost: Math.round(extraCost * 100) / 100 };
      const ev = evidence(['date', 'person_key', 'model', 'rows', 'cost_usd'],
        g.map((x) => [x.date, vis(x.person_key), x.model, x.c, x.cost]), g.length);
      if (g.length) {
        out.push(fail(p.id, `${platformName(p.id)} has ${g.length} groups repeated at date, person and model (${extraRows} extra rows).`, metrics, ev, extraRows));
      } else {
        out.push(pass(p.id, `${platformName(p.id)} is unique at the usage grain.`, metrics, ev));
      }
    }
    return out;
  },
};
