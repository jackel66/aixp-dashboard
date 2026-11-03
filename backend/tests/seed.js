'use strict';
// seedFixture(opts): generate -> createDataset -> loadTables -> normalize -> verify -> promote.
// Other suites call this to get an active dataset in their temp database.
// opts: {seed, months, people, profile, defects, endDate, label, promote = true, previous = false, compareTo}
// compareTo: dataset id or null to pin the comparison; omitted means the active dataset.
// previous: first load and promote a clean dataset with months - 1 so delta checks have a baseline.
const fixture = require('../src/services/fixture');
const staging = require('../src/services/staging');
const { normalize } = require('../src/services/normalize');
const datasets = require('../src/services/datasets');

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

function seedFixture(opts = {}) {
  const base = {
    seed: opts.seed, months: opts.months === undefined ? 12 : opts.months, people: opts.people,
    endDate: opts.endDate,
  };
  let previousId = null;
  if (opts.previous) {
    const pfx = fixture.generate({ ...base, months: Math.max(1, base.months - 1), profile: 'clean' });
    previousId = loadFixture(pfx, 'Previous fixture');
    datasets.verify(previousId, { compareTo: null });
    datasets.promote(previousId, { force: true });
  }
  const fx = fixture.generate({ ...base, profile: opts.profile || 'clean', defects: opts.defects });
  const datasetId = loadFixture(fx, opts.label || 'Fixture');
  const run = datasets.verify(datasetId, opts.previous ? { compareTo: previousId } : opts.compareTo === undefined ? {} : { compareTo: opts.compareTo });
  if (opts.promote !== false) datasets.promote(datasetId, { force: true });
  return { datasetId, previousId, verdict: run.verdict, run, meta: fx.meta };
}

module.exports = { seedFixture, loadFixture };
