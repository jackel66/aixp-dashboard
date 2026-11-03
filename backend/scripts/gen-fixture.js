'use strict';
// Fixture generator CLI.
//   node scripts/gen-fixture.js --out <dir> [--seed N --months N --people N --profile clean|defective]
//   node scripts/gen-fixture.js --seed-db --profile clean|defective [--seed N --months N --people N] [--no-previous]
// --seed-db writes into DB_PATH (or backend/data/aixp.db), loads a clean previous dataset first, then the requested
// one, verifies and promotes it, and prints the verdict.
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const has = (name) => process.argv.includes(`--${name}`);

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, ''); return; }
  const cols = Object.keys(rows[0]);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, cols.map(csvCell).join(',') + '\r\n');
  let buf = [];
  for (const r of rows) {
    buf.push(cols.map((c) => csvCell(r[c])).join(','));
    if (buf.length >= 5000) { fs.writeSync(fd, buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) fs.writeSync(fd, buf.join('\r\n') + '\r\n');
  fs.closeSync(fd);
}

const t0 = Date.now();
const lap = (label, since) => console.log(`[gen-fixture] ${label}: ${((Date.now() - since) / 1000).toFixed(2)} s`);

function main() {
  const fixture = require('../src/services/fixture');
  const opts = {
    seed: arg('seed') === undefined ? undefined : parseInt(arg('seed'), 10),
    months: arg('months') === undefined ? undefined : parseInt(arg('months'), 10),
    people: arg('people') === undefined ? undefined : parseInt(arg('people'), 10),
    profile: arg('profile', 'clean'),
    endDate: arg('end-date') === undefined ? undefined : String(arg('end-date')),
  };
  if (opts.profile !== 'clean' && opts.profile !== 'defective') throw new Error('--profile must be clean or defective');

  if (has('out')) {
    const dir = path.resolve(String(arg('out')));
    fs.mkdirSync(dir, { recursive: true });
    let s = Date.now();
    const fx = fixture.generate(opts);
    lap('generate', s);
    s = Date.now();
    writeCsv(path.join(dir, 'usage.csv'), fx.usage);
    writeCsv(path.join(dir, 'people.csv'), fx.people);
    writeCsv(path.join(dir, 'seat_rate.csv'), fx.seatRate);
    writeCsv(path.join(dir, 'region_map.csv'), fx.regionMap);
    writeCsv(path.join(dir, 'lob_cg_map.csv'), fx.lobCgMap);
    lap('write csv', s);
    console.log(`[gen-fixture] wrote ${fx.usage.length} usage rows, ${fx.people.length} people rows to ${dir}`);
  }

  if (has('seed-db')) {
    const db = require('../src/db');
    const staging = require('../src/services/staging');
    const { normalize } = require('../src/services/normalize');
    const datasets = require('../src/services/datasets');
    db.open();
    console.log(`[gen-fixture] database: ${db.dbPath()}`);

    const run = (fxOpts, label, compareTo) => {
      let s = Date.now();
      const fx = fixture.generate(fxOpts);
      lap(`${label} generate (${fx.usage.length} usage rows, ${fx.people.length} people rows)`, s);
      s = Date.now();
      const id = staging.createDataset({
        label, source: 'fixture', seed: fx.meta.seed,
        options: { seed: fx.meta.seed, months: fx.meta.months, people: fx.meta.people, profile: fx.meta.profile,
          defects: fx.meta.defects, endDate: fx.meta.endDate, exportDate: fx.meta.exportDate },
      });
      staging.loadTables(id, fx);
      lap(`${label} load`, s);
      s = Date.now();
      const counts = normalize(id);
      lap(`${label} normalize (${counts.usageRows} usage rows kept)`, s);
      s = Date.now();
      const v = datasets.verify(id, compareTo === undefined ? {} : { compareTo });
      lap(`${label} verify (${v.fail_count} fail, ${v.warn_count} warn, ${v.info_count} info, ${v.pass_count} pass)`, s);
      s = Date.now();
      datasets.promote(id, { force: true });
      lap(`${label} promote`, s);
      return { id, v };
    };

    let prevId = null;
    if (!has('no-previous')) {
      const months = Math.max(1, (opts.months || 12) - 1);
      prevId = run({ ...opts, months, profile: 'clean' }, 'previous (clean)', null).id;
    }
    const cur = run(opts, `current (${opts.profile})`, prevId === null ? null : prevId);
    for (const r of cur.v.results) {
      if (r.status === 'fail') console.log(`[gen-fixture]   FAIL ${r.severity.padEnd(4)} ${r.check_id}${r.platform ? ` [${r.platform}]` : ''}: ${r.message}`);
    }
    console.log(`[gen-fixture] verdict: ${cur.v.verdict} (dataset ${cur.id}, ${cur.v.fail_count} fail, ${cur.v.warn_count} warn)`);
    db.close();
  }

  if (!has('out') && !has('seed-db')) {
    console.log('Usage: node scripts/gen-fixture.js --out <dir> | --seed-db  [--profile clean|defective] [--seed N] [--months N] [--people N]');
  }
  console.log(`[gen-fixture] total: ${((Date.now() - t0) / 1000).toFixed(2)} s`);
}

main();
