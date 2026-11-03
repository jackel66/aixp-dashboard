'use strict';
const { registerFunctions } = require('../normalize');
const { evidence, pass, fail, skip, vis } = require('./util');

module.exports = {
  id: 'cowork_cumulative_snapshots',
  title: 'Cowork snapshots are cumulative and kept once',
  severity: 'warn',
  platformScoped: false,
  meaning:
    'Cowork exports carry Monthly credits used, a cumulative monthly value. Successive snapshots must not be summed; ' +
    'normalization keeps the latest snapshot per person and month, dated at the snapshot, so it is a monthly total, not daily usage.',
  run(ctx) {
    registerFunctions(ctx.db);
    const stage = ctx.db
      .prepare(
        `SELECT aixp_ukey(person_key, 'cowork') AS k, aixp_date(date) AS d, aixp_num(credits) AS c
         FROM stage_usage WHERE dataset_id = ? AND aixp_platform(platform) = 'cowork'
           AND aixp_date(date) IS NOT NULL AND aixp_num(credits) IS NOT NULL AND aixp_ukey(person_key, 'cowork') <> ''
         ORDER BY k, d, row_no`
      )
      .all(ctx.datasetId);
    if (!stage.length) return skip(null, 'No Copilot Cowork rows in this dataset.');
    const drops = [];
    let dropTotal = 0;
    let prev = null;
    for (const r of stage) {
      const same = prev && prev.k === r.k && prev.d.slice(0, 7) === r.d.slice(0, 7);
      if (same && r.c < prev.c) {
        dropTotal += 1;
        if (drops.length < 50) drops.push([vis(r.k), r.d.slice(0, 7), prev.d, prev.c, r.d, r.c]);
      }
      prev = r;
    }
    const multi = ctx.db
      .prepare(
        `SELECT person_key, substr(date, 1, 7) AS m, count(*) AS n FROM usage
         WHERE dataset_id = ? AND platform = 'cowork' GROUP BY person_key, m HAVING count(*) > 1`
      )
      .all(ctx.datasetId);
    const people = new Set(stage.map((r) => `${r.k}|${r.d.slice(0, 7)}`)).size;
    const kept = ctx.db.prepare("SELECT count(*) AS n FROM usage WHERE dataset_id = ? AND platform = 'cowork'").get(ctx.datasetId).n;
    const metrics = {
      stageSnapshots: stage.length, personMonths: people, keptRows: kept, decreasingSteps: dropTotal, personMonthsWithManyRows: multi.length,
    };
    if (dropTotal || multi.length) {
      return fail(null,
        `${dropTotal} Cowork snapshots fall below the previous one in the same month and ${multi.length} person-months have more than one normalized row. ` +
        'Monthly credits used should only grow within a month, with one row kept.',
        metrics,
        evidence(['person_key', 'month', 'previous_date', 'previous_credits', 'date', 'credits'], drops, dropTotal),
        dropTotal + multi.length);
    }
    return pass(null,
      `Cowork snapshots are non-decreasing within each month and normalization kept one row for each of ${people} person-months.`,
      metrics, evidence(['person_months', 'stage_snapshots', 'kept_rows'], [[people, stage.length, kept]]));
  },
};
