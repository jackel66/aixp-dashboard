'use strict';
const { registerFunctions, keyRaw } = require('../normalize');
const { evidence, pass, fail, vis } = require('./util');

module.exports = {
  id: 'people_key_unique_nonblank',
  title: 'Person keys are nonblank and collapse cleanly',
  severity: 'fail',
  platformScoped: false,
  meaning:
    'PersonKey must be normalized (lowercase, non-breaking spaces replaced, trimmed) before grouping, and blank keys ' +
    'excluded. Cleaning after grouping leaves separate groups that collapse to duplicate keys.',
  run(ctx) {
    registerFunctions(ctx.db);
    const raw = new Set();
    let blankUsage = 0;
    let blankPeople = 0;
    for (const r of ctx.db.prepare('SELECT person_key AS k, count(*) AS n FROM stage_usage WHERE dataset_id = ? GROUP BY person_key').all(ctx.datasetId)) {
      raw.add(r.k === null ? '' : r.k);
      if (!keyRaw(r.k)) blankUsage += r.n;
    }
    for (const r of ctx.db.prepare('SELECT person_key AS k, count(*) AS n FROM stage_people WHERE dataset_id = ? GROUP BY person_key').all(ctx.datasetId)) {
      raw.add(r.k === null ? '' : r.k);
      if (!keyRaw(r.k)) blankPeople += r.n;
    }
    const byNorm = new Map();
    for (const k of raw) {
      const nk = keyRaw(k);
      if (!nk) continue;
      if (!byNorm.has(nk)) byNorm.set(nk, []);
      byNorm.get(nk).push(k);
    }
    const collapsing = [];
    for (const [nk, list] of byNorm) if (list.length > 1) collapsing.push([nk, list.length, list.map(vis).join(' | ')]);
    collapsing.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const metrics = { blankUsageRows: blankUsage, blankPeopleRows: blankPeople, collapsingKeys: collapsing.length };
    const ev = evidence(['normalized_key', 'raw_variants', 'raw_keys'], collapsing, collapsing.length);
    if (blankUsage || blankPeople || collapsing.length) {
      return fail(null,
        `${blankUsage + blankPeople} rows have a blank key and ${collapsing.length} keys appear in more than one raw spelling ` +
        '(case or non-breaking space). Normalization merges them; the source needs cleaning.',
        metrics, ev, blankUsage + blankPeople + collapsing.length);
    }
    return pass(null, 'No blank person keys and no raw spellings that collapse to the same key.', metrics, ev);
  },
};
