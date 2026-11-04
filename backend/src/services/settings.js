'use strict';
// Settings store: key -> JSON value. Defaults are seeded by db.open() from defaults.js.
// Builder B registers validators in VALIDATORS (key -> fn(value) -> cleaned value, or throw badRequest).
const { getDb } = require('../db');
const { badRequest } = require('../errors');
const { broadcast } = require('./events');
const secrets = require('./secrets');

// Keys stored encrypted. GET shows them as {set: bool}; server code uses getSecret().
const SECRET_KEYS = new Set(['powerbi.client_secret', 'powerbi.token', 'ad.bind_password']);

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

const text = (name, max, re) => (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw badRequest(`${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${name} is too long (max ${max} characters)`);
  if (re && t && !re.test(t)) throw badRequest(`${name} has characters that are not allowed`);
  return t;
};
const bool = (name) => (v) => {
  if (typeof v !== 'boolean') throw badRequest(`${name} must be true or false`);
  return v;
};
const PBI_TABLE_KEYS = ['usage', 'people', 'seat_rate', 'region_map', 'lob_cg_map'];
const PBI_TABLE_NAME = /^[A-Za-z0-9 _.-]+$/;

const VALIDATORS = {
  'ad.enabled': bool('ad.enabled'),
  'ad.domain': (v) => text('ad.domain', 253, /^[A-Za-z0-9._-]+$/)(v).toLowerCase(),
  'ad.bind_user': text('ad.bind_user', 256),
  'ad.servers': (v) => {
    const raw = Array.isArray(v) ? v.join(' ') : v;
    const t = text('ad.servers', 2000)(raw);
    return t.split(/[\s,;]+/).filter(Boolean).join(', ');
  },
  'ad.base_dn': text('ad.base_dn', 500),
  'ad.tls_mode': oneOf('ad.tls_mode', ['auto', 'ldaps', 'starttls']),
  'ad.tls_verify': bool('ad.tls_verify'),
  'ad.ca_cert': (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') throw badRequest('ad.ca_cert must be text');
    if (v.length > 20000) throw badRequest('ad.ca_cert is too long');
    return v.trim();
  },
  'ad.sync_minutes': intRange('ad.sync_minutes', 5, 1440),
  'ad.deactivate_removed': bool('ad.deactivate_removed'),
  'powerbi.enabled': bool('powerbi.enabled'),
  'powerbi.auth_mode': oneOf('powerbi.auth_mode', ['service_principal', 'token']),
  'powerbi.tenant_id': text('powerbi.tenant_id', 100, /^[A-Za-z0-9._-]+$/),
  'powerbi.client_id': text('powerbi.client_id', 64, /^[A-Za-z0-9-]+$/),
  'powerbi.workspace_id': text('powerbi.workspace_id', 64, /^[A-Za-z0-9-]+$/),
  'powerbi.dataset_id': text('powerbi.dataset_id', 64, /^[A-Za-z0-9-]+$/),
  'powerbi.dataset_name': text('powerbi.dataset_name', 200),
  'powerbi.tables': (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest('powerbi.tables must be an object');
    for (const k of Object.keys(v)) if (!PBI_TABLE_KEYS.includes(k)) throw badRequest(`powerbi.tables: unknown table key "${k}"`);
    const cur = get('powerbi.tables', {}) || {};
    const out = {};
    for (const k of PBI_TABLE_KEYS) {
      const raw = v[k] === undefined ? cur[k] : v[k];
      const t = text(`powerbi.tables.${k}`, 4000)(raw);
      if (t && !/^evaluate\b/i.test(t) && !PBI_TABLE_NAME.test(t)) {
        throw badRequest(`powerbi.tables.${k} must be a table name or a DAX query that starts with EVALUATE`);
      }
      out[k] = t;
    }
    return out;
  },
  'powerbi.date_column': (v) => {
    const t = text('powerbi.date_column', 100, PBI_TABLE_NAME)(v);
    if (!t) throw badRequest('powerbi.date_column is required');
    return t;
  },
  'powerbi.months_back': intRange('powerbi.months_back', 1, 60),
  'powerbi.auto_promote': bool('powerbi.auto_promote'),
  'powerbi.schedule': (v) => {
    const t = text('powerbi.schedule', 5)(v);
    if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw badRequest('powerbi.schedule must be blank or HH:MM (24 hour, Phoenix time)');
    return t;
  },
  'powerbi.last_pull_at': (v) => (v === null || v === '' ? null : text('powerbi.last_pull_at', 40)(v)),
  'powerbi.last_pull': (v) => {
    if (v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('powerbi.last_pull must be an object or null');
    return v;
  },
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
  if (SECRET_KEYS.has(key)) return { set: !!getSecret(key) };
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback === undefined ? null : fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback === undefined ? null : fallback; }
}

function set(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// Stored values exactly as written (secrets stay encrypted). Internal use only.
function storedAll() {
  const out = {};
  for (const r of getDb().prepare('SELECT key, value FROM settings ORDER BY key').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = null; }
  }
  return out;
}

// Everything the API may show: secrets become {set: true|false}.
function allRaw() {
  const out = storedAll();
  for (const k of Object.keys(out)) if (k.startsWith('ad.')) delete out[k];
  for (const k of SECRET_KEYS) if (!k.startsWith('ad.')) out[k] = { set: typeof out[k] === 'string' && out[k] !== '' };
  return out;
}

// Plain text of a secret, or '' when none is stored. Never log or return this.
function getSecret(key) {
  if (!SECRET_KEYS.has(key)) throw new Error(`${key} is not a secret key`);
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return '';
  let v;
  try { v = JSON.parse(row.value); } catch (e) { return ''; }
  if (typeof v !== 'string' || v === '') return '';
  return secrets.decrypt(v);
}

// Returns the value to store: undefined = keep what is there, '' = clear, else the ciphertext.
function secretPatch(key, raw) {
  if (raw === null) return ''; // null clears
  if (raw === undefined || raw === '' || (typeof raw === 'object' && !Array.isArray(raw))) {
    return undefined; // '' or the masked object {set: ...} keeps the stored secret
  }
  if (typeof raw !== 'string') throw badRequest(`${key} must be text`);
  if (raw.length > 8192) throw badRequest(`${key} is too long`);
  return secrets.encrypt(raw);
}

function checkValue(key, v) {
  const fn = VALIDATORS[key];
  return fn ? fn(v) : v;
}

// Keys the directory page may write. ad.discovered and ad.status are written by the service itself.
const AD_WRITABLE = ['ad.enabled', 'ad.domain', 'ad.bind_user', 'ad.bind_password', 'ad.servers', 'ad.base_dn',
  'ad.tls_mode', 'ad.tls_verify', 'ad.ca_cert', 'ad.sync_minutes', 'ad.deactivate_removed'];

function apply(body, mode) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body must be a JSON object');
  const changed = [];
  const cleaned = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw badRequest(`Bad settings key "${key}"`);
    const isAd = key.startsWith('ad.');
    if (mode === 'settings' && isAd) throw badRequest('Directory settings are saved under /api/access/directory');
    if (mode === 'ad' && !AD_WRITABLE.includes(key)) throw badRequest(`Unknown directory setting "${key}"`);
    if (SECRET_KEYS.has(key)) {
      const p = secretPatch(key, raw);
      if (p !== undefined) cleaned[key] = p;
    } else {
      cleaned[key] = checkValue(key, raw);
    }
  }
  const before = storedAll();
  const tx = getDb().transaction(() => {
    for (const [k, v] of Object.entries(cleaned)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(v)) changed.push(k);
      set(k, v);
    }
  });
  tx();
  return changed;
}

// Apply a settings patch. Returns the full settings object and broadcasts the changed keys.
function update(body) {
  const changed = apply(body, 'settings');
  if (changed.length) broadcast('settings.changed', { keys: changed });
  return allRaw();
}

// Directory patch (ad.* keys only). Returns the keys that changed; the caller broadcasts.
function updateAd(body) {
  return apply(body, 'ad');
}

module.exports = { get, set, allRaw, update, updateAd, getSecret, SECRET_KEYS, VALIDATORS };
