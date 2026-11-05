'use strict';
const express = require('express');
const datasets = require('../services/datasets');
const reports = require('../services/reports');
const { getDb } = require('../db');
const { notFound, badRequest } = require('../errors');

const router = express.Router();

const row = (d) => ({
  id: d.id, label: d.label, source: d.source, seed: d.seed, status: d.status, verdict: d.verdict, created_at: d.created_at,
  verified_at: d.verified_at, promoted_at: d.promoted_at, archived_at: d.archived_at, platforms: d.platforms,
  provider: d.provider, options: d.options,
});

function idParam(v) {
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1) throw badRequest('Dataset id must be a positive integer');
  return id;
}

router.get('/', (req, res) => {
  const a = datasets.active();
  res.json({ active_id: a ? a.id : null, rows: datasets.list().map((d) => Object.assign(row(d), { note: d.note })) });
});

router.post('/rollback', (req, res) => {
  const to = idParam(req.body && req.body.to);
  res.json(datasets.rollback(to));
});

router.get('/:id', (req, res) => {
  const d = datasets.get(idParam(req.params.id));
  if (!d) throw notFound('Dataset');
  res.json(Object.assign(row(d), { counts: d.counts, options: d.options, note: d.note }));
});

router.post('/:id/verify', (req, res) => {
  const id = idParam(req.params.id);
  if (!datasets.get(id)) throw notFound('Dataset');
  const body = req.body || {};
  const opts = body.compareTo === undefined ? {} : { compareTo: body.compareTo };
  const run = datasets.verify(id, opts);
  const full = getDb().prepare('SELECT * FROM verification_runs WHERE id = ?').get(run.id);
  res.json(Object.assign(reports.runShape(full), { compared_to_dataset_id: run.compared_to_dataset_id }));
});

router.post('/:id/promote', (req, res) => {
  const id = idParam(req.params.id);
  if (!datasets.get(id)) throw notFound('Dataset');
  res.json(datasets.promote(id, { force: !!(req.body && req.body.force) }));
});

module.exports = router;
