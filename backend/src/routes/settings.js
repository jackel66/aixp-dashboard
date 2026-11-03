'use strict';
const express = require('express');
const { getDb } = require('../db');
const settings = require('../services/settings');
const datasets = require('../services/datasets');
const rollups = require('../services/rollups');
const platforms = require('../platforms');
const { broadcast } = require('../services/events');
const { badRequest, HttpError } = require('../errors');

const router = express.Router();

function activeId() {
  const a = datasets.active();
  if (!a) throw new HttpError(404, 'No active dataset yet');
  return a.id;
}

router.get('/', (req, res) => res.json(settings.allRaw()));

router.put('/', (req, res) => {
  const body = req.body || {};
  const patch = body.patch === undefined ? body : body.patch;
  res.json(settings.update(patch));
});

router.get('/seat-rates', (req, res) => {
  const id = activeId();
  const rows = getDb().prepare(
    'SELECT platform, month, rate_usd, licensed_seats FROM seat_rate WHERE dataset_id = ? ORDER BY platform, month'
  ).all(id);
  res.json({ rows });
});

router.put('/seat-rates', (req, res) => {
  const id = activeId();
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows)) throw badRequest('rows must be an array');
  if (rows.length > 5000) throw badRequest('Too many rows');
  const seen = new Set();
  const clean = rows.map((r, i) => {
    if (!r || typeof r !== 'object') throw badRequest(`Row ${i + 1} must be an object`);
    if (!platforms.byId(r.platform)) throw badRequest(`Row ${i + 1}: unknown platform "${r.platform}"`);
    if (typeof r.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month)) throw badRequest(`Row ${i + 1}: month must be YYYY-MM`);
    const rate = Number(r.rate_usd);
    const seats = Number(r.licensed_seats);
    if (r.rate_usd === null || r.rate_usd === '' || !Number.isFinite(rate) || rate < 0) throw badRequest(`Row ${i + 1}: rate_usd must be zero or more`);
    if (r.licensed_seats === null || r.licensed_seats === '' || !Number.isFinite(seats) || seats < 0) throw badRequest(`Row ${i + 1}: licensed_seats must be zero or more`);
    const k = `${r.platform}|${r.month}`;
    if (seen.has(k)) throw badRequest(`Row ${i + 1}: duplicate ${r.platform} ${r.month}`);
    seen.add(k);
    return { platform: r.platform, month: r.month, rate_usd: rate, licensed_seats: seats };
  });
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM seat_rate WHERE dataset_id = ?').run(id);
    const ins = db.prepare('INSERT INTO seat_rate (dataset_id, platform, month, rate_usd, licensed_seats) VALUES (?, ?, ?, ?, ?)');
    for (const r of clean) ins.run(id, r.platform, r.month, r.rate_usd, r.licensed_seats);
    rollups.rebuildOrg(db, id);
  })();
  broadcast('settings.changed', { keys: ['seat-rates'] });
  res.json({ rows: clean.sort((a, b) => (a.platform + a.month < b.platform + b.month ? -1 : 1)) });
});

const pairKey = (jf, lob) => `${String(jf || '').replace(/\u00a0/g, ' ').trim().toLowerCase()}\u0001${String(lob || '').replace(/\u00a0/g, ' ').trim().toLowerCase()}`;

router.get('/lob-cg-map', (req, res) => {
  const id = activeId();
  const rows = getDb().prepare(
    'SELECT job_function, u_lob_2, lob_cg, lob_cg_sort FROM lob_cg_map WHERE dataset_id = ? ORDER BY lob_cg_sort, lob_cg, job_function, u_lob_2'
  ).all(id);
  res.json({ rows });
});

router.put('/lob-cg-map', (req, res) => {
  const id = activeId();
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows)) throw badRequest('rows must be an array');
  if (rows.length > 5000) throw badRequest('Too many rows');
  const sortByLabel = new Map();
  const seen = new Set();
  const clean = rows.map((r, i) => {
    if (!r || typeof r !== 'object') throw badRequest(`Row ${i + 1} must be an object`);
    const label = String(r.lob_cg === undefined || r.lob_cg === null ? '' : r.lob_cg).trim();
    if (!label) throw badRequest(`Row ${i + 1}: lob_cg is required`);
    const sort = Number(r.lob_cg_sort);
    if (r.lob_cg_sort === null || r.lob_cg_sort === '' || !Number.isFinite(sort)) throw badRequest(`Row ${i + 1}: lob_cg_sort must be a number`);
    if (sortByLabel.has(label) && sortByLabel.get(label) !== sort) {
      throw badRequest(`Row ${i + 1}: "${label}" has more than one sort value (${sortByLabel.get(label)} and ${sort}); use one per label`);
    }
    sortByLabel.set(label, sort);
    const jf = String(r.job_function === undefined || r.job_function === null ? '' : r.job_function).trim();
    const lob2 = String(r.u_lob_2 === undefined || r.u_lob_2 === null ? '' : r.u_lob_2).trim();
    const k = pairKey(jf, lob2);
    if (seen.has(k)) throw badRequest(`Row ${i + 1}: duplicate job_function and u_lob_2 pair`);
    seen.add(k);
    return { job_function: jf, u_lob_2: lob2, lob_cg: label, lob_cg_sort: sort };
  });
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM lob_cg_map WHERE dataset_id = ?').run(id);
    const ins = db.prepare('INSERT INTO lob_cg_map (dataset_id, job_function, u_lob_2, lob_cg, lob_cg_sort) VALUES (?, ?, ?, ?, ?)');
    for (const r of clean) ins.run(id, r.job_function, r.u_lob_2, r.lob_cg, r.lob_cg_sort);
    // Same pairing rule as normalize: (job_function, u_lob_2), trimmed and case-insensitive; no pair -> Unassigned.
    const byPair = new Map(clean.map((r) => [pairKey(r.job_function, r.u_lob_2), r]));
    const upd = db.prepare('UPDATE people SET lob_cg = ?, lob_cg_sort = ? WHERE dataset_id = ? AND person_key = ?');
    for (const p of db.prepare('SELECT person_key, job_function, u_lob_2 FROM people WHERE dataset_id = ?').all(id)) {
      const m = byPair.get(pairKey(p.job_function, p.u_lob_2));
      upd.run(m ? m.lob_cg : 'Unassigned', m ? m.lob_cg_sort : 999, id, p.person_key);
    }
    rollups.rebuildOrg(db, id);
  })();
  broadcast('settings.changed', { keys: ['lob-cg-map'] });
  res.json({ rows: clean });
});

module.exports = router;
