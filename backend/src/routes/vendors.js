'use strict';
// Vendor connector routes (CONTRACT section 16.1). Permission gating comes from the api gate
// (data.manage, except GET /vendors/detail which needs people.view).
const express = require('express');
const settings = require('../services/settings');
const connectors = require('../services/connectors');
const imp = require('../services/vendorImport');
const schedule = require('../services/vendorSchedule');
const datasets = require('../services/datasets');
const scopeMod = require('../services/scope');
const { getDb } = require('../db');
const { wrap, badRequest, notFound } = require('../errors');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAIL_CAP = 50000;

router.get('/', (req, res) => {
  const any = connectors.enabledIds().length > 0;
  res.json({
    connectors: connectors.list(),
    schedule: settings.get('vendors.schedule', ''),
    auto_promote: !!settings.get('vendors.auto_promote', true),
    months_back: Number(settings.get('vendors.months_back', 13)) || 13,
    running: imp.isRunning(),
    last_pull_at: settings.get('vendors.last_pull_at', null),
    last_pull: settings.get('vendors.last_pull', null),
    next_run_at: any ? schedule.nextRunAt() : null,
  });
});

// Product breakdown the usage grain cannot hold. A scoped caller sees only people in their LOB-CG values.
router.get('/detail', wrap((req, res) => {
  const q = req.query;
  const vendor = String(q.vendor || 'anthropic');
  if (!connectors.get(vendor)) throw badRequest(`Unknown vendor "${vendor}"`);
  for (const k of ['from', 'to']) if (q[k] !== undefined && !DATE_RE.test(String(q[k]))) throw badRequest(`${k} must be a date (YYYY-MM-DD)`);
  const scope = req.auth.scope;
  scopeMod.assertNotEmpty(scope);
  const a = datasets.active();
  const w = scopeMod.peopleWhere(scope, 'p');
  const where = ['d.vendor = ?'];
  const params = [a ? a.id : -1, vendor];
  if (q.from) { where.push('d.date >= ?'); params.push(String(q.from)); }
  if (q.to) { where.push('d.date <= ?'); params.push(String(q.to)); }
  if (q.person_key) { where.push('d.person_key = ?'); params.push(String(q.person_key).trim().toLowerCase()); }
  if (q.product) { where.push('d.product = ?'); params.push(String(q.product)); }
  if (w.sql) { where.push(w.sql); params.push(...w.params); }
  const rows = getDb().prepare(
    `SELECT d.vendor, d.date, d.person_key, d.email, d.model, d.product, d.tokens, d.cost_usd, d.list_cost_usd, d.requests, d.pulled_at
     FROM vendor_usage_detail d LEFT JOIN people p ON p.dataset_id = ? AND p.person_key = d.person_key
     WHERE ${where.join(' AND ')} ORDER BY d.date, d.person_key, d.model, d.product LIMIT ${DETAIL_CAP + 1}`
  ).all(...params);
  const truncated = rows.length > DETAIL_CAP;
  res.json({ rows: truncated ? rows.slice(0, DETAIL_CAP) : rows, truncated });
}));

router.post('/pull', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.ids !== undefined && !Array.isArray(b.ids)) throw badRequest('ids must be a list of connector ids');
  const o = {};
  if (Array.isArray(b.ids)) o.ids = b.ids.map(String);
  if (typeof b.promote === 'boolean') o.promote = b.promote;
  res.json(await imp.pull(o));
}));

router.post('/:id/test', wrap(async (req, res) => {
  const c = connectors.get(req.params.id);
  if (!c) throw notFound('Connector');
  res.json(await c.test());
}));

// Connector actions (CONTRACT 18.1): a sign-in flow started and polled from the connector card.
function actionOf(req) {
  const c = connectors.get(req.params.id);
  if (!c) throw notFound('Connector');
  const a = c.actions && Object.prototype.hasOwnProperty.call(c.actions, req.params.key) ? c.actions[req.params.key] : null;
  if (!a) throw notFound('Action');
  return a;
}
router.post('/:id/actions/:key', wrap(async (req, res) => {
  res.json(await actionOf(req).start());
}));
router.get('/:id/actions/:key', wrap(async (req, res) => {
  res.json(await actionOf(req).status());
}));

module.exports = router;
