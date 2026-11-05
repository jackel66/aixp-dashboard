'use strict';
// Rows copied back out of the ACTIVE dataset in primer column names, so a pull that does not cover
// a table (or a platform) keeps what the last load had. Used by the Power BI and vendor importers.
const { getDb } = require('../db');
const datasets = require('./datasets');
const { PLATFORMS } = require('../platforms');

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// Lookup tables and people (key: seat_rate | region_map | lob_cg_map | people).
function activeCopy(key) {
  const a = datasets.active();
  if (!a) return [];
  const db = getDb();
  if (key === 'seat_rate') {
    return db.prepare('SELECT platform, month, rate_usd, licensed_seats FROM seat_rate WHERE dataset_id = ?').all(a.id)
      .map((r) => ({ Platform: r.platform, Month: r.month, RateUSD: r.rate_usd, LicensedSeats: r.licensed_seats }));
  }
  if (key === 'region_map') {
    return db.prepare('SELECT office_code, region FROM region_map WHERE dataset_id = ?').all(a.id)
      .map((r) => ({ OfficeCode: r.office_code, Region: r.region }));
  }
  if (key === 'lob_cg_map') {
    return db.prepare('SELECT job_function, u_lob_2, lob_cg, lob_cg_sort FROM lob_cg_map WHERE dataset_id = ?').all(a.id)
      .map((r) => ({ job_function: r.job_function, u_lob_2: r.u_lob_2, 'LOB-CG': r.lob_cg, 'LOB-CG Sort': r.lob_cg_sort }));
  }
  if (key === 'people') {
    const type = { Associate: 'Employee', 'Non-Associate': 'Contractor' };
    // People that a vendor org supplied (origin 'vendor') are derived again after normalize, never copied as extract rows.
    const skipVendor = hasColumn(db, 'people', 'origin') ? " AND coalesce(origin, 'extract') <> 'vendor'" : '';
    return db.prepare(
      `SELECT person_key, email, user_id, display_name, u_lob_2, job_function, office_code, sbl, person_type, extract_as_of
       FROM people WHERE dataset_id = ?${skipVendor}`
    ).all(a.id).map((r) => ({
      PersonKey: r.person_key, email: r.email, 'User ID': r.user_id, DisplayName: r.display_name, u_lob_2: r.u_lob_2,
      job_function: r.job_function, OfficeCode: r.office_code, u_bo_fier_sbl: r.sbl,
      u_cg_person_type_code: type[r.person_type] || '', ExtractAsOf: r.extract_as_of,
    }));
  }
  return [];
}

// Usage rows of one platform from the active dataset, back in primer column names.
// opts.before: only dates strictly before this YYYY-MM-DD. cost_source 'none' stays blank, not 0.
function activeUsage(platformId, opts = {}) {
  const a = datasets.active();
  if (!a) return [];
  const p = PLATFORMS.find((x) => x.id === platformId);
  if (!p) return [];
  const db = getDb();
  const where = opts.before ? ' AND date < ?' : '';
  const params = opts.before ? [a.id, platformId, opts.before] : [a.id, platformId];
  return db.prepare(
    `SELECT date, person_key, platform, model, tokens, credits, consumption, consumption_unit, cost_usd, cost_source,
       requests, discount_amount, net_amount
     FROM usage WHERE dataset_id = ? AND platform = ?${where} ORDER BY id`
  ).all(...params).map((r) => ({
    Date: r.date, PersonKey: r.person_key, Platform: p.name, Model: r.model, Tokens: r.tokens, Credits: r.credits,
    Consumption: r.consumption, ConsumptionUnit: r.consumption_unit, CostUSD: r.cost_source === 'none' ? null : r.cost_usd,
    Requests: r.requests, discount_amount: r.discount_amount, net_amount: r.net_amount,
  }));
}

// Map of lowercase trimmed e-mail -> person_key for one dataset's People. When several people share an
// e-mail the first person_key (sorted) wins, so the result is stable. Vendors identify people by e-mail,
// the People table by alias, and the primer joins on e-mail.
function emailToPersonKey(datasetId) {
  const map = new Map();
  if (datasetId === null || datasetId === undefined) return map;
  const rows = getDb().prepare("SELECT person_key, email FROM people WHERE dataset_id = ? AND coalesce(email, '') <> '' ORDER BY person_key").all(datasetId);
  for (const r of rows) {
    const e = String(r.email).replace(/\u00a0/g, ' ').trim().toLowerCase();
    if (e && !map.has(e)) map.set(e, r.person_key);
  }
  return map;
}

module.exports = { activeCopy, activeUsage, emailToPersonKey };
