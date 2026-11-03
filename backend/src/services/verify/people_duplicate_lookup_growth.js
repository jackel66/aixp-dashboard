'use strict';
const { registerFunctions } = require('../normalize');
const { evidence, pass, fail } = require('./util');

module.exports = {
  id: 'people_duplicate_lookup_growth',
  title: 'People rows did not grow in the lookups',
  severity: 'fail',
  platformScoped: false,
  meaning:
    'After the region and LOB-CG merges, People must still have exactly one row per distinct person key. A duplicate ' +
    'lookup match multiplies People rows and then multiplies usage spend.',
  run(ctx) {
    registerFunctions(ctx.db);
    const expected = ctx.db
      .prepare("SELECT count(DISTINCT aixp_keyraw(person_key)) AS n FROM stage_people WHERE dataset_id = ? AND aixp_keyraw(person_key) <> ''")
      .get(ctx.datasetId).n;
    const rows = ctx.db.prepare('SELECT count(*) AS n, count(DISTINCT person_key) AS d FROM people WHERE dataset_id = ?').get(ctx.datasetId);
    const regionDup = ctx.db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT upper(trim(office_code)) AS c FROM stage_region_map WHERE dataset_id = ? AND trim(office_code) <> ''
           GROUP BY c HAVING count(DISTINCT trim(coalesce(region, ''))) > 1)`
      )
      .get(ctx.datasetId).n;
    const metrics = { stageDistinctKeys: expected, peopleRows: rows.n, peopleDistinctKeys: rows.d, officeCodesWithConflictingRegions: regionDup };
    const ev = evidence(['measure', 'value'],
      [['distinct keys in stage', expected], ['people rows', rows.n], ['distinct people keys', rows.d], ['office codes with conflicting regions', regionDup]]);
    if (rows.n !== expected || rows.n !== rows.d) {
      return fail(null, `People has ${rows.n} rows for ${expected} distinct keys (${rows.d} distinct in People). A lookup multiplied rows.`, metrics, ev, Math.abs(rows.n - expected));
    }
    return pass(null,
      `People has ${rows.n} rows, one per distinct person key${regionDup ? `; ${regionDup} office codes carry conflicting regions in RegionMap, first one used` : ''}.`,
      metrics, ev);
  },
};
