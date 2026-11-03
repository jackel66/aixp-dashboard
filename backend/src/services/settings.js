'use strict';
// Settings store: key -> JSON value. Defaults are seeded by db.open() from defaults.js.
// Builder B registers validators in VALIDATORS (key -> fn(value) -> cleaned value, or throw badRequest).
const { getDb } = require('../db');
const { badRequest } = require('../errors');
const { broadcast } = require('./events');

const VALIDATORS = {};

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
