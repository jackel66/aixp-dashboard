'use strict';
const { diffDays } = require('../time');
const { evidence, pass, fail, skip, platformName, PLATFORMS } = require('./util');

module.exports = {
  id: 'freshness_per_platform',
  title: 'Each platform is current',
  severity: 'fail',
  platformScoped: true,
  meaning:
    'Each platform must reach close to the newest date in the data. An overall maximum date can hide one stale ' +
    'platform, so freshness is judged per platform against that overall maximum.',
  run(ctx) {
    const rows = ctx.db
      .prepare('SELECT platform, min(date) AS min_date, max(date) AS max_date, count(*) AS n FROM usage WHERE dataset_id = ? GROUP BY platform')
      .all(ctx.datasetId);
    const by = {};
    let overall = null;
    for (const r of rows) {
      by[r.platform] = r;
      if (!overall || r.max_date > overall) overall = r.max_date;
    }
    const stale = Number(ctx.settings['verify.stale_days'] === undefined ? 5 : ctx.settings['verify.stale_days']);
    let carried = new Set();
    try {
      const o = JSON.parse((ctx.db.prepare('SELECT options_json FROM datasets WHERE id = ?').get(ctx.datasetId) || {}).options_json || '{}') || {};
      if (o.provider === 'vendor') {
        const pulled = new Set((o.connectors || []).map((id) => (require('../connectors').get(id) || {}).platform || id));
        carried = new Set(PLATFORMS.map((p) => p.id).filter((id) => !pulled.has(id)));
      }
    } catch (e) { carried = new Set(); }
    const out = [];
    for (const p of PLATFORMS) {
      const r = by[p.id];
      if (!r) { out.push(skip(p.id, `${p.name} has no usage rows in this dataset.`)); continue; }
      const lag = diffDays(r.max_date, overall);
      const metrics = { asOf: r.max_date, overallMax: overall, lagDays: lag, staleDays: stale };
      const ev = evidence(['platform', 'latest_date', 'overall_max', 'lag_days'], [[platformName(p.id), r.max_date, overall, lag]]);
      if (lag > stale && carried.has(p.id)) {
        // Carried over from the previous dataset until the platform has a connector: a warning, not a failure.
        const f = fail(p.id,
          `${platformName(p.id)} stopped at ${r.max_date}, ${lag} days behind the overall maximum ${overall}; carried over from the previous dataset.`,
          Object.assign(metrics, { carriedOver: true }), ev, lag);
        f.severity = 'warn';
        out.push(f);
      } else if (lag > stale) {
        out.push(fail(p.id,
          `${platformName(p.id)} stopped at ${r.max_date}, ${lag} days behind the overall maximum ${overall}. ` +
          'The overall maximum date hid it.', metrics, ev, lag));
      } else {
        out.push(pass(p.id, lag === 0 ? `${platformName(p.id)} is current (${r.max_date}).` : `${platformName(p.id)} is ${lag} days behind the overall maximum, inside the ${stale} day limit.`, metrics, ev));
      }
    }
    return out;
  },
};
