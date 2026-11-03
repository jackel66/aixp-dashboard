'use strict';
// CSV export: first line is "# " + CAVEAT, cells starting with = + - @ (or tab/CR) get a leading
// apostrophe so spreadsheets do not run them as formulas. Numbers are written as-is.
const { CAVEAT } = require('../platforms');

function cell(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else {
    s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = [`# ${CAVEAT}`, columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const val = (c) => (c ? c.value : null);

// report data -> {columns, rows}; consumption is always written with its unit column.
function flatten(report, d) {
  if (report === 'summary') {
    const rows = d.platforms.map((p) => ({
      platform: p.id, name: p.name, as_of: p.as_of, lag_days: p.lag_days, rows: p.rows,
      consumption_spend_usd: p.spend.consumption.usd, seat_spend_usd: p.spend.seat.usd, total_spend_usd: p.spend.total.usd,
      consumption: p.consumption.value, unit: p.consumption.unit, active_users: p.active_users,
    }));
    rows.push({
      platform: 'all', name: 'All platforms', consumption_spend_usd: d.totals.spend.consumption.usd,
      seat_spend_usd: d.totals.spend.seat.usd, total_spend_usd: d.totals.spend.total.usd, active_users: d.totals.active_users,
    });
    return {
      columns: ['platform', 'name', 'as_of', 'lag_days', 'rows', 'consumption_spend_usd', 'seat_spend_usd', 'total_spend_usd',
        'consumption', 'unit', 'active_users'],
      rows,
    };
  }
  if (report === 'trend') {
    const rows = [];
    for (const b of d.buckets) {
      for (const [id, c] of Object.entries(b.platforms)) {
        rows.push({
          start: b.start, label: b.label, platform: id, basis: d.basis, usd: c.usd, active_users: c.active_users,
          consumption: c.consumption.value, unit: c.consumption.unit,
        });
      }
    }
    return { columns: ['start', 'label', 'platform', 'basis', 'usd', 'active_users', 'consumption', 'unit'], rows };
  }
  if (report === 'platform') {
    const rows = [];
    for (const t of d.trend) {
      rows.push({
        section: 'trend', name: t.start, usd: t.usd, consumption: val(t.consumption), unit: t.consumption.unit, users: t.active_users,
      });
    }
    for (const m of d.models) {
      rows.push({ section: 'model', name: m.model, usd: m.usd, consumption: m.consumption.value, unit: m.consumption.unit, users: m.users, share: m.share });
    }
    for (const u of d.top_users) {
      rows.push({ section: 'top_user', name: u.display_name, key: u.person_key, usd: u.usd, consumption: u.consumption.value, unit: u.consumption.unit });
    }
    return { columns: ['section', 'name', 'key', 'usd', 'consumption', 'unit', 'users', 'share'], rows };
  }
  if (report === 'organization') {
    const rows = [];
    for (const r of d.rows) {
      for (const [id, c] of Object.entries(r.cells)) {
        rows.push({
          key: r.key, label: r.label, platform: id, basis: d.basis, usd: c.usd, active_users: c.active_users,
          consumption: c.consumption.value, unit: c.consumption.unit,
        });
      }
    }
    return { columns: ['key', 'label', 'platform', 'basis', 'usd', 'active_users', 'consumption', 'unit'], rows };
  }
  if (report === 'models') {
    return {
      columns: ['platform', 'model', 'usd', 'consumption', 'unit', 'requests', 'users', 'share', 'cost_per_unit'],
      rows: d.rows.map((r) => ({
        platform: r.platform, model: r.model, usd: r.usd, consumption: r.consumption.value, unit: r.consumption.unit,
        requests: r.requests, users: r.users, share: r.share, cost_per_unit: r.cost_per_unit,
      })),
    };
  }
  // users
  const ids = Array.from(new Set(d.rows.flatMap((r) => Object.keys(r.platforms))));
  return {
    columns: ['person_key', 'display_name', 'lob_cg', 'region', 'sbl', 'person_type', 'matched', 'usd', 'active_days']
      .concat(ids.map((i) => `usd_${i}`)),
    rows: d.rows.map((r) => {
      const o = { ...r };
      for (const i of ids) o[`usd_${i}`] = r.platforms[i];
      return o;
    }),
  };
}

// A report run (reportRunner.run) -> {columns, rows}. units become <key> and <key>_unit, delta becomes
// <key>_now, _prev, _delta and _pct. Totals are appended as a last row when present.
function flattenReport(rep) {
  const columns = [];
  const spec = [];
  for (const c of rep.columns) {
    if (c.type === 'units') {
      columns.push(c.key, `${c.key}_unit`);
    } else if (c.type === 'delta') {
      columns.push(`${c.key}_now`, `${c.key}_prev`, `${c.key}_delta`, `${c.key}_pct`);
    } else columns.push(c.key);
    spec.push(c);
  }
  function shape(r) {
    const o = {};
    for (const c of spec) {
      const v = r[c.key];
      if (c.type === 'units') {
        o[c.key] = v ? v.value : null;
        o[`${c.key}_unit`] = v ? v.unit : null;
      } else if (c.type === 'delta') {
        o[`${c.key}_now`] = v ? v.now : null;
        o[`${c.key}_prev`] = v ? v.prev : null;
        o[`${c.key}_delta`] = v ? v.delta : null;
        o[`${c.key}_pct`] = v ? v.pct : null;
      } else o[c.key] = v === undefined ? null : v;
    }
    return o;
  }
  const rows = rep.rows.map(shape);
  if (rep.totals) rows.push(shape(rep.totals));
  return { columns, rows };
}

module.exports = { toCsv, flatten, flattenReport, cell };
