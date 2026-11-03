'use strict';
// Settings store: key -> JSON value. Defaults are seeded by db.open() from defaults.js.
// Builder B registers validators in VALIDATORS (key -> fn(value) -> cleaned value, or throw badRequest).
const { getDb } = require('../db');
const { badRequest } = require('../errors');
const { broadcast } = require('./events');

const intRange = (name, lo, hi) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) throw badRequest(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
};
const numRange = (name, lo, hi) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw badRequest(`${name} must be a number from ${lo} to ${hi}`);
  return n;
};
const oneOf = (name, list) => (v) => {
  if (!list.includes(v)) throw badRequest(`${name} must be one of: ${list.join(', ')}`);
  return v;
};

const VALIDATORS = {
  'spend.seat_basis': oneOf('spend.seat_basis', ['licensed', 'active']),
  'spend.default_basis': oneOf('spend.default_basis', ['consumption', 'seat', 'total']),
  'cowork.rate': numRange('cowork.rate', 0, 1),
  'cowork.rate_confirmed': (v) => {
    if (typeof v !== 'boolean') throw badRequest('cowork.rate_confirmed must be true or false');
    return v;
  },
  'verify.stale_days': intRange('verify.stale_days', 0, 365),
  'verify.gap_days': intRange('verify.gap_days', 0, 365),
  'verify.unmatched_pct': numRange('verify.unmatched_pct', 0, 100),
  'verify.delta_pct': numRange('verify.delta_pct', 0, 1000),
  'datasets.keep': intRange('datasets.keep', 1, 50),
  'fixture.options': (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest('fixture.options must be an object');
    return {
      seed: intRange('fixture.options.seed', 1, 2147483647)(v.seed),
      months: intRange('fixture.options.months', 1, 36)(v.months),
      people: intRange('fixture.options.people', 10, 5000)(v.people),
      profile: oneOf('fixture.options.profile', ['clean', 'defective'])(v.profile),
    };
  },
  'lobcg.seed': (v) => {
    if (!Array.isArray(v) || v.length > 500) throw badRequest('lobcg.seed must be an array of mapping rows');
    const sorts = new Map();
    return v.map((r, i) => {
      if (!r || typeof r !== 'object') throw badRequest(`lobcg.seed row ${i + 1} must be an object`);
      const label = typeof r.lob_cg === 'string' ? r.lob_cg.trim() : '';
      const sort = Number(r.lob_cg_sort);
      if (!label) throw badRequest(`lobcg.seed row ${i + 1}: lob_cg is required`);
      if (!Number.isFinite(sort)) throw badRequest(`lobcg.seed row ${i + 1}: lob_cg_sort must be a number`);
      if (sorts.has(label) && sorts.get(label) !== sort) throw badRequest(`lobcg.seed: "${label}" has more than one sort value`);
      sorts.set(label, sort);
      return {
        job_function: String(r.job_function === undefined || r.job_function === null ? '' : r.job_function).trim(),
        u_lob_2: String(r.u_lob_2 === undefined || r.u_lob_2 === null ? '' : r.u_lob_2).trim(),
        lob_cg: label, lob_cg_sort: sort,
      };
    });
  },
};

function get(key, fallback) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback === undefined ? null : fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback === undefined ? null : fallback; }
}

function set(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function allRaw() {
  const out = {};
  for (const r of getDb().prepare('SELECT key, value FROM settings ORDER BY key').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = null; }
  }
  return out;
}

function checkValue(key, v) {
  const fn = VALIDATORS[key];
  return fn ? fn(v) : v;
}

// Apply a settings patch. Returns the full settings object and broadcasts the changed keys.
function update(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body must be a JSON object');
  const changed = [];
  const cleaned = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw badRequest(`Bad settings key "${key}"`);
    cleaned[key] = checkValue(key, raw);
  }
  const before = allRaw();
  const tx = getDb().transaction(() => {
    for (const [k, v] of Object.entries(cleaned)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(v)) changed.push(k);
      set(k, v);
    }
  });
  tx();
  if (changed.length) broadcast('settings.changed', { keys: changed });
  return allRaw();
}

module.exports = { get, set, allRaw, update, VALIDATORS };
