'use strict';
const { evidence, pass, skip } = require('./util');

module.exports = {
  id: 'vendor_org_disagreement',
  title: 'Vendor orgs agree with the extract LOB',
  severity: 'info',
  platformScoped: false,
  meaning:
    'People from the extract whose vendor org maps to a different LOB-CG than the extract says. The extract value always ' +
    'stands; this list is only a prompt to look at the mapping or the extract.',
  run(ctx) {
    const total = ctx.db.prepare('SELECT count(*) AS n FROM vendor_org_values').get().n;
    if (!total) return skip(null, 'No vendor org values have been received.');
    const sortOf = new Map();
    const note = (label, sort) => {
      const s = Number.isFinite(Number(sort)) ? Number(sort) : 999;
      if (!sortOf.has(label) || s < sortOf.get(label)) sortOf.set(label, s);
    };
    for (const r of ctx.db.prepare('SELECT lob_cg, lob_cg_sort FROM lob_cg_map WHERE dataset_id = ?').all(ctx.datasetId)) note(r.lob_cg, r.lob_cg_sort);
    for (const r of ctx.db.prepare('SELECT lob_cg, min(lob_cg_sort) AS s FROM people WHERE dataset_id = ? GROUP BY lob_cg').all(ctx.datasetId)) note(r.lob_cg, r.s);
    const cand = ctx.db
      .prepare(
        `SELECT p.person_key, p.lob_cg AS extract_lob, vp.vendor, vp.value, v.lob_cg AS mapped_lob
         FROM people p JOIN vendor_org_people vp ON vp.person_key = p.person_key
           JOIN vendor_org_values v ON v.vendor = vp.vendor AND v.value = vp.value
         WHERE p.dataset_id = ? AND p.origin = 'extract' AND v.lob_cg IS NOT NULL
         ORDER BY p.person_key, vp.vendor, vp.value`
      )
      .all(ctx.datasetId);
    // One resolved value per person: the first mapped value by lob_cg_sort.
    const pick = new Map();
    for (const c of cand) {
      const s = sortOf.has(c.mapped_lob) ? sortOf.get(c.mapped_lob) : 999;
      const cur = pick.get(c.person_key);
      if (!cur || s < cur.sort || (s === cur.sort && c.mapped_lob < cur.mapped_lob)) pick.set(c.person_key, { ...c, sort: s });
    }
    const diff = Array.from(pick.values()).filter((c) => c.mapped_lob !== c.extract_lob);
    const ev = evidence(['person_key', 'extract_lob_cg', 'vendor_org', 'mapped_lob_cg'],
      diff.map((c) => [c.person_key, c.extract_lob, `${c.vendor}: ${c.value}`, c.mapped_lob]), diff.length);
    return pass(null,
      diff.length
        ? `${diff.length} people have a vendor org that maps to a different LOB-CG than the extract; the extract value is kept.`
        : 'Vendor orgs agree with the extract LOB for every person they cover.',
      { disagreements: diff.length, compared: pick.size }, ev);
  },
};
