'use strict';
const { evidence, pass, skip, money } = require('./util');

// Which share of a vendor's organization total the per-user rows account for (CONTRACT section 16.3).
// Info only: usage the vendor cannot attribute to a person (deleted or unattributed actors) is expected.
module.exports = {
  id: 'vendor_coverage',
  title: 'Vendor user rows cover the organization total',
  severity: 'info',
  platformScoped: true,
  meaning:
    'A vendor pull reads the organization total from the vendor as well as the per-user rows. This shows how much of ' +
    'the total landed on a named person. The rest is usage the vendor reports without a user.',
  run(ctx) {
    const row = ctx.db.prepare('SELECT options_json FROM datasets WHERE id = ?').get(ctx.datasetId);
    let options = {};
    try { options = JSON.parse((row && row.options_json) || '{}') || {}; } catch (e) { options = {}; }
    if (options.provider !== 'vendor') return [skip('anthropic', 'This dataset was not loaded by a vendor pull.')];
    const cov = options.coverage || {};
    const out = [];
    for (const [vendor, c] of Object.entries(cov)) {
      if (!c || !(c.org_total_usd > 0)) {
        out.push(skip(vendor, `${vendor}: the vendor reported no organization total for the window.`));
        continue;
      }
      const pct = Math.round((c.user_rows_usd / c.org_total_usd) * 1000) / 10;
      const metrics = { org_total_usd: c.org_total_usd, user_rows_usd: c.user_rows_usd, pct, data_refreshed_at: c.data_refreshed_at || null };
      const ev = evidence(
        ['vendor', 'org_total_usd', 'user_rows_usd', 'covered_pct', 'data_refreshed_at'],
        [[vendor, c.org_total_usd, c.user_rows_usd, pct, c.data_refreshed_at || '']]
      );
      out.push(pass(vendor, `User-attributed rows cover ${pct}% of the organization total (${money(c.user_rows_usd)} of ${money(c.org_total_usd)}).`, metrics, ev));
    }
    if (!out.length) out.push(skip('anthropic', 'No vendor coverage figures were recorded for this dataset.'));
    return out;
  },
};
