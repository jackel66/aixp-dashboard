'use strict';
const express = require('express');
const { getDb } = require('../db');
const datasets = require('../services/datasets');
const reports = require('../services/reports');
const platforms = require('../platforms');
const { CHECKS } = require('../services/verify');
const { HttpError, notFound, badRequest } = require('../errors');

const router = express.Router();

function resolveDatasetId(q) {
  if (q.dataset !== undefined && q.dataset !== '') {
    const id = Number(q.dataset);
    if (!Number.isInteger(id) || id < 1) throw badRequest('dataset must be a dataset id');
    if (!datasets.get(id)) throw notFound('Dataset');
    return id;
  }
  const a = datasets.active();
  if (!a) throw new HttpError(404, 'No active dataset yet');
  return a.id;
}

router.get('/', (req, res) => {
  const db = getDb();
  const id = resolveDatasetId(req.query);
  const run = reports.latestRun(db, id);
  if (!run) {
    // Nothing verified yet: list every check as skipped, one per platform when scoped.
    const checks = [];
    for (const c of CHECKS) {
      const scopes = c.platformScoped ? platforms.IDS : [null];
      for (const p of scopes) {
        checks.push({
          id: c.id, title: c.title, severity: c.severity, status: 'skip', platform: p, message: 'Not run yet.', metrics: {},
          meaning: c.meaning, affected: 0,
        });
      }
    }
    return res.json({ run: null, checks });
  }
  const checks = db.prepare('SELECT * FROM verification_results WHERE run_id = ? ORDER BY id').all(run.id)
    .map((r) => reports.checkShape(r, false));
  return res.json({ run: reports.runShape(run), checks });
});

router.get('/runs/:runId', (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(Number(req.params.runId));
  if (!run) throw notFound('Run');
  const checks = db.prepare('SELECT * FROM verification_results WHERE run_id = ? ORDER BY id').all(run.id)
    .map((r) => reports.checkShape(r, true));
  res.json(Object.assign(reports.runShape(run), { compared_to_dataset_id: run.compared_to_dataset_id, checks }));
});

router.get('/runs/:runId/checks/:checkId', (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(Number(req.params.runId));
  if (!run) throw notFound('Run');
  const platform = req.query.platform ? String(req.query.platform) : null;
  const rows = db.prepare('SELECT * FROM verification_results WHERE run_id = ? AND check_id = ? ORDER BY id')
    .all(run.id, req.params.checkId);
  const row = platform ? rows.find((r) => r.platform === platform) : rows.find((r) => !r.platform) || rows[0];
  if (!row) throw notFound('Check');
  const history = db.prepare(
    `SELECT vr.run_id, r.ran_at, vr.status FROM verification_results vr JOIN verification_runs r ON r.id = vr.run_id
     WHERE r.dataset_id = ? AND vr.check_id = ? AND coalesce(vr.platform, '') = ? ORDER BY vr.run_id DESC LIMIT 10`
  ).all(run.dataset_id, row.check_id, row.platform || '');
  res.json(Object.assign(reports.checkShape(row, true), { history }));
});

module.exports = router;
