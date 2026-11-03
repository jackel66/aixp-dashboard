'use strict';
// Fixture generation: POST /api/fixtures/generate, plus the helpers server.js uses for the first-boot seed.
const express = require('express');
const fixture = require('../services/fixture');
const staging = require('../services/staging');
const { normalize } = require('../services/normalize');
const datasets = require('../services/datasets');
const settings = require('../services/settings');
const { broadcast } = require('../services/events');
const { badRequest } = require('../errors');

const router = express.Router();

// generate -> createDataset -> loadTables -> normalize. Returns the staging dataset id.
function loadFixture(fx, label) {
  const id = staging.createDataset({
    label,
    source: 'fixture',
    seed: fx.meta.seed,
    options: {
      seed: fx.meta.seed, months: fx.meta.months, people: fx.meta.people, profile: fx.meta.profile,
      defects: fx.meta.defects, endDate: fx.meta.endDate, exportDate: fx.meta.exportDate,
    },
  });
  staging.loadTables(id, fx);
  normalize(id);
  return id;
}

// Full pipeline for one fixture: load, verify, promote (forced, fixtures are allowed to fail checks).
function runPipeline(opts, label, { compareTo, promote = true, log } = {}) {
  const fx = fixture.generate(opts);
  const id = loadFixture(fx, label);
  if (log) log(`${label}: loaded ${fx.usage.length} usage rows, ${fx.people.length} people rows as dataset ${id}`);
  const run = datasets.verify(id, compareTo === undefined ? {} : { compareTo });
  if (log) log(`${label}: verdict ${run.verdict} (${run.fail_count} fail, ${run.warn_count} warn)`);
  if (promote) {
    datasets.promote(id, { force: true });
    if (log) log(`${label}: promoted`);
  }
  return { id, verdict: run.verdict, promoted: promote, meta: fx.meta };
}

function intIn(v, name, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw badRequest(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
}

router.post('/generate', (req, res) => {
  const b = req.body || {};
  const cur = settings.get('fixture.options', {}) || {};
  const opts = {
    seed: b.seed === undefined ? cur.seed : intIn(b.seed, 'seed', 1, 2147483647),
    months: b.months === undefined ? cur.months : intIn(b.months, 'months', 1, 36),
    people: b.people === undefined ? cur.people : intIn(b.people, 'people', 10, 5000),
    profile: b.profile === undefined ? cur.profile || 'clean' : b.profile,
  };
  if (opts.profile !== 'clean' && opts.profile !== 'defective') throw badRequest('profile must be clean or defective');
  if (b.defects !== undefined) {
    if (!b.defects || typeof b.defects !== 'object' || Array.isArray(b.defects)) throw badRequest('defects must be an object of flags');
    opts.defects = b.defects;
  }
  if (b.promote !== undefined && typeof b.promote !== 'boolean') throw badRequest('promote must be true or false');
  const promote = b.promote === undefined ? true : b.promote;
  const label = `Fixture ${opts.seed} (${opts.profile})`;
  const out = runPipeline(opts, label, { promote: false });
  settings.update({ 'fixture.options': { seed: opts.seed, months: opts.months, people: opts.people, profile: opts.profile } });
  broadcast('fixture.generated', { id: out.id });
  if (promote) datasets.promote(out.id, { force: true });
  out.promoted = promote;
  res.json({ dataset_id: out.id, verdict: out.verdict, promoted: out.promoted });
});

module.exports = router;
module.exports.loadFixture = loadFixture;
module.exports.runPipeline = runPipeline;
