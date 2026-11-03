'use strict';
// Entry point. First boot: when no dataset is active, seed a clean "previous" fixture and the
// current one (from fixture.options) so the delta checks have a baseline (CONTRACT section 5).
const { open } = require('./db');
const { createApp } = require('./app');
const datasets = require('./services/datasets');
const settings = require('./services/settings');
const { runPipeline } = require('./routes/fixtures');

const log = (m) => console.log(`[seed] ${m}`);

function firstBootSeed() {
  if (datasets.active()) return;
  const opts = settings.get('fixture.options', {}) || {};
  const base = { seed: opts.seed, months: opts.months || 12, people: opts.people, profile: opts.profile || 'defective' };
  log(`no active dataset; generating fixtures (seed ${base.seed}, ${base.months} months, ${base.people} people, ${base.profile})`);
  let previousId = null;
  if (base.months > 1) {
    previousId = runPipeline({ ...base, months: base.months - 1, profile: 'clean' }, 'Previous fixture (clean)', { compareTo: null, log }).id;
  }
  runPipeline(base, `Fixture ${base.seed} (${base.profile})`, { compareTo: previousId === null ? null : previousId, log });
  const purged = datasets.purge();
  log(`purge: stage ${purged.stagePurged.length} dataset(s), usage ${purged.usagePurged.length} dataset(s)`);
}

async function main() {
  open();
  firstBootSeed();
  const port = parseInt(process.env.PORT, 10) || 3090;
  const app = createApp();
  const server = app.listen(port, () => console.log(`[server] listening on http://localhost:${port}`));
  server.on('error', (e) => { console.error('[server] failed to start:', e.message); process.exit(1); });
}

main().catch((e) => { console.error('[server] fatal:', e.stack || e); process.exit(1); });
