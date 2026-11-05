'use strict';
const { evidence, pass, fail, skip } = require('./util');

module.exports = {
  id: 'vendor_org_unmatched',
  title: 'Vendor org values map to a LOB-CG',
  severity: 'warn',
  platformScoped: false,
  meaning:
    'A vendor org or group that holds people but has no LOB-CG mapping leaves those people without a line of business ' +
    'when the extract does not carry them. Map each value in Settings, LOB-CG map, Vendor orgs; fuzzy suggestions are ' +
    'never applied on their own.',
  run(ctx) {
    const total = ctx.db.prepare('SELECT count(*) AS n FROM vendor_org_values').get().n;
    if (!total) return skip(null, 'No vendor org values have been received.');
    const rows = ctx.db
      .prepare('SELECT vendor, value, people_count FROM vendor_org_values WHERE lob_cg IS NULL AND people_count > 0 ORDER BY people_count DESC, vendor, value')
      .all();
    const org = require('../orgCorrelation');
    const shown = rows.slice(0, 50).map((r) => {
      const sug = org.matchValue(r.vendor, r.value).suggestions;
      return [r.value, r.vendor, r.people_count, sug.map((s) => `${s.lob_cg} ${s.score.toFixed(2)}`).join('; ')];
    });
    const ev = evidence(['value', 'vendor', 'people', 'suggestions'], shown, rows.length);
    const people = rows.reduce((a, r) => a + r.people_count, 0);
    if (rows.length) {
      return fail(null, `${rows.length} vendor org values with ${people} people have no LOB-CG mapping.`,
        { values: rows.length, people, total }, ev, people);
    }
    return pass(null, 'Every vendor org value that holds people is mapped to a LOB-CG.', { values: 0, people: 0, total }, ev);
  },
};
