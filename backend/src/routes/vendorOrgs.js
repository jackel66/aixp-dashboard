'use strict';
// Vendor org -> LOB-CG mapping (CONTRACT section 16.4). settings.manage, like /settings/lob-cg-map.
const express = require('express');
const org = require('../services/orgCorrelation');
const authService = require('../services/authService');
const { broadcast } = require('../services/events');
const { badRequest } = require('../errors');

const router = express.Router();

function audit(req, detail) {
  authService.logEvent({
    kind: 'org_map_changed', username: req.auth.user.username, userId: req.auth.user.id, source: req.auth.user.source,
    ip: req.ip, detail, actor: req.auth.user.id,
  });
  broadcast('settings.changed', { keys: ['vendor_orgs'] });
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('id must be a positive integer');
  return n;
};

router.get('/', (req, res) => res.json(org.listValues(first(req.query.vendor) || null)));

router.get('/export.csv', (req, res) => {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="aixp-vendor-orgs.csv"',
    'Cache-Control': 'no-store',
  });
  res.send(org.exportCsv(first(req.query.vendor) || null));
});

router.post('/aliases', (req, res) => {
  const b = req.body || {};
  if (typeof b.alias !== 'string' || typeof b.lob_cg !== 'string') throw badRequest('alias and lob_cg are required');
  const row = org.addAlias(b.alias, b.lob_cg, req.auth.user.id);
  audit(req, JSON.stringify({ action: 'alias_added', alias: row.alias, lob_cg: row.lob_cg }));
  res.status(201).json(row);
});

router.delete('/aliases/:id', (req, res) => {
  const a = org.removeAlias(idOf(req));
  audit(req, JSON.stringify({ action: 'alias_removed', alias: a.alias, lob_cg: a.lob_cg }));
  res.json({ ok: true });
});

router.post('/apply', (req, res) => {
  const out = org.applyNow();
  audit(req, JSON.stringify({ action: 'apply', people_created: out.people_created, mapped: out.mapped }));
  res.json(out);
});

router.get('/:id/people', (req, res) => res.json(org.peopleFor(idOf(req))));

router.put('/:id', (req, res) => {
  const id = idOf(req);
  const b = req.body || {};
  if (!('lob_cg' in b)) throw badRequest('lob_cg is required (a LOB-CG value, or null to clear)');
  if (b.lob_cg !== null && typeof b.lob_cg !== 'string') throw badRequest('lob_cg must be a string or null');
  const out = org.setMapping(id, b.lob_cg, b.method, req.auth.user.id);
  audit(req, JSON.stringify({ vendor: out.row.vendor, value: out.row.value, lob_cg: out.row.lob_cg, method: out.method }));
  res.json(out.row);
});

module.exports = router;
