'use strict';
const { evidence, pass, fail } = require('./util');

module.exports = {
  id: 'lob_cg_label_split',
  title: 'Each LOB-CG label has one sort value',
  severity: 'fail',
  platformScoped: false,
  meaning:
    'A LOB-CG label must carry one sort value. Different sort values for the same label show up as two identical ' +
    'categories in a matrix, split by sort order.',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT lob_cg, count(DISTINCT lob_cg_sort) AS n, group_concat(DISTINCT lob_cg_sort) AS sorts,
           sum(src = 'map') AS in_map, sum(src = 'people') AS in_people FROM (
           SELECT lob_cg, lob_cg_sort, 'map' AS src FROM lob_cg_map WHERE dataset_id = @ds
           UNION ALL
           SELECT lob_cg, lob_cg_sort, 'people' AS src FROM people WHERE dataset_id = @ds
         ) GROUP BY lob_cg HAVING count(DISTINCT lob_cg_sort) > 1 ORDER BY lob_cg`
      )
      .all({ ds: ctx.datasetId });
    const affected = rows.length
      ? ctx.db
        .prepare(
          `SELECT count(*) AS n FROM people WHERE dataset_id = ? AND lob_cg IN (${rows.map(() => '?').join(',')})`
        )
        .get(ctx.datasetId, ...rows.map((r) => r.lob_cg)).n
      : 0;
    const ev = evidence(['lob_cg', 'sort_values', 'sorts', 'map_rows', 'people_rows'],
      rows.map((r) => [r.lob_cg, r.n, r.sorts, r.in_map, r.in_people]), rows.length);
    if (rows.length) {
      return fail(null, `${rows.length} LOB-CG labels carry more than one sort value: ${rows.map((r) => r.lob_cg).join(', ')}.`,
        { labels: rows.length, peopleAffected: affected }, ev, affected);
    }
    return pass(null, 'Every LOB-CG label has exactly one sort value.', { labels: 0 }, ev);
  },
};
