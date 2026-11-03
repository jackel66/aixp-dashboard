'use strict';
const { evidence, pass, fail, skip, platformName, vis, PLATFORMS } = require('./util');

const MIN_REPEAT_ROWS = 8;

module.exports = {
  id: 'seat_spend_not_in_rows',
  title: 'Seat spend is not written into usage rows',
  severity: 'fail',
  platformScoped: true,
  meaning:
    'Seat spend lives in the seat-rate table by month. It must not be repeated on every daily usage row; a row that ' +
    `equals the monthly seat cost, or one identical cost on every day of a month (${MIN_REPEAT_ROWS} or more rows), is a sign it was.`,
  run(ctx) {
    const present = new Set(
      ctx.db.prepare('SELECT DISTINCT platform FROM usage WHERE dataset_id = ?').all(ctx.datasetId).map((r) => r.platform)
    );
    const eq = ctx.db
      .prepare(
        `SELECT u.platform, u.date, u.person_key, u.cost_usd, s.rate_usd * s.licensed_seats AS seat_cost
         FROM usage u JOIN seat_rate s ON s.dataset_id = u.dataset_id AND s.platform = u.platform AND s.month = substr(u.date, 1, 7)
         WHERE u.dataset_id = ? AND s.rate_usd * s.licensed_seats > 0 AND u.cost_usd > 0
           AND abs(u.cost_usd - s.rate_usd * s.licensed_seats) < 0.005`
      )
      .all(ctx.datasetId);
    const rep = ctx.db
      .prepare(
        `SELECT platform, person_key, substr(date, 1, 7) AS month, count(*) AS n, min(cost_usd) AS cost
         FROM usage WHERE dataset_id = ? AND cost_usd > 0 AND platform <> 'cowork'
         GROUP BY platform, person_key, month
         HAVING count(*) >= ${MIN_REPEAT_ROWS} AND count(DISTINCT round(cost_usd, 4)) = 1
         ORDER BY n DESC, platform, person_key, month`
      )
      .all(ctx.datasetId);
    const out = [];
    for (const p of PLATFORMS) {
      if (!present.has(p.id)) { out.push(skip(p.id, `${p.name} has no usage rows in this dataset.`)); continue; }
      const e = eq.filter((x) => x.platform === p.id);
      const r = rep.filter((x) => x.platform === p.id);
      const repRows = r.reduce((a, x) => a + x.n, 0);
      const metrics = { rowsEqualToSeatCost: e.length, repeatingPersonMonths: r.length, repeatingRows: repRows, minRepeatRows: MIN_REPEAT_ROWS };
      const evRows = r.map((x) => [vis(x.person_key), x.month, x.n, x.cost, 'same cost every day'])
        .concat(e.map((x) => [vis(x.person_key), x.date.slice(0, 7), 1, x.cost_usd, 'equals seat rate x seats']));
      const ev = evidence(['person_key', 'month', 'rows', 'cost_usd', 'pattern'], evRows, r.length + e.length);
      if (e.length || r.length) {
        out.push(fail(p.id,
          `${platformName(p.id)}: ${r.length} person-months repeat one cost on every day (${repRows} rows) and ${e.length} rows equal the monthly seat cost. Seat spend appears to be inside usage rows.`,
          metrics, ev, repRows + e.length));
      } else {
        out.push(pass(p.id, `${platformName(p.id)}: no usage row carries seat spend.`, metrics, ev));
      }
    }
    return out;
  },
};
