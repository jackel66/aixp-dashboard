'use strict';
// Power BI connector routes (CONTRACT section 13). Password gating comes from the api gate.
const express = require('express');
const settings = require('../services/settings');
const client = require('../services/powerbiClient');
const imp = require('../services/powerbiImport');
const schedule = require('../services/powerbiSchedule');
const { wrap } = require('../errors');

const router = express.Router();

router.post('/test', wrap(async (req, res) => {
  res.json(await imp.test());
}));

router.get('/datasets', wrap(async (req, res) => {
  res.json(await client.listDatasets());
}));

router.post('/pull', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await imp.pull(typeof b.promote === 'boolean' ? { promote: b.promote } : {}));
}));

router.get('/status', (req, res) => {
  res.json({
    configured: imp.isConfigured(),
    enabled: !!settings.get('powerbi.enabled', false),
    running: imp.isRunning(),
    last_pull_at: settings.get('powerbi.last_pull_at', null),
    last_pull: settings.get('powerbi.last_pull', null),
    schedule: settings.get('powerbi.schedule', ''),
    next_run_at: settings.get('powerbi.enabled', false) ? schedule.nextRunAt() : null,
  });
});

module.exports = router;
