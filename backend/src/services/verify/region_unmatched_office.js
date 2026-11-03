'use strict';
const { evidence, pass, fail } = require('./util');

module.exports = {
  id: 'region_unmatched_office',
  title: 'Office codes resolve to a region',
  severity: 'warn',
  platformScoped: false,
  meaning:
    'RegionMap needs one row per normalized office code. An office with no row lands in an Unknown region; it stays ' +
    'visible but should be mapped.',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT office_code, count(*) AS n FROM people
         WHERE dataset_id = @ds AND trim(office_code) <> ''
           AND upper(trim(office_code)) NOT IN (SELECT office_code FROM region_map WHERE dataset_id = @ds)
         GROUP BY office_code ORDER BY n DESC, office_code`
      )
      .all({ ds: ctx.datasetId });
    const people = rows.reduce((a, r) => a + r.n, 0);
    const ev = evidence(['office_code', 'people'], rows.map((r) => [r.office_code, r.n]), rows.length);
    if (rows.length) {
      return fail(null, `${people} people sit in ${rows.length} office codes that are not in RegionMap (${rows.map((r) => r.office_code).join(', ')}).`,
        { offices: rows.length, people }, ev, people);
    }
    return pass(null, 'Every office code resolves to a region.', { offices: 0, people: 0 }, ev);
  },
};
