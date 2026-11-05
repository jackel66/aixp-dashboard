'use strict';
// Vendor pull: one pull for every enabled connector into ONE dataset, through staging -> normalize ->
// verify -> promote (CONTRACT section 16.1). Mirrors powerbiImport.pull: same progress events, same
// dataset lifecycle, same last-pull bookkeeping.
const { getDb } = require('../db');
const settings = require('./settings');
const connectors = require('./connectors');
const win = require('./connectors/window');
const staging = require('./staging');
const { normalize } = require('./normalize');
const datasets = require('./datasets');
const { activeCopy, activeUsage, emailToPersonKey } = require('./activeCopy');
const importLock = require('./importLock');
const { broadcast } = require('./events');
const time = require('./time');
const { PLATFORMS } = require('../platforms');
const { conflict, badRequest, HttpError } = require('../errors');

const log = (m) => console.log(`[vendors] ${m}`);

function progress(stage, extra) {
  broadcast('import.progress', Object.assign({ stage, vendor: null, table: null, chunk: null, rows: null, message: '' }, extra || {}));
}

const isRunning = () => importLock.isBusy();

function labelStamp() {
  const d = time.now();
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: time.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${time.todayPhoenix(d)} ${hm}`;
}

function saveLastPull(summary) {
  settings.set('vendors.last_pull_at', time.nowIso());
  settings.set('vendors.last_pull', summary);
  broadcast('settings.changed', { keys: ['vendors.last_pull_at', 'vendors.last_pull'] });
}

// Which connectors a pull covers. ids narrows to those connectors (they must be enabled).
function chooseConnectors(ids) {
  const enabled = connectors.enabledIds();
  let pick = enabled;
  if (Array.isArray(ids) && ids.length) {
    for (const id of ids) {
      if (!connectors.get(id)) throw badRequest(`Unknown connector "${id}"`);
      if (!enabled.includes(id)) throw badRequest(`Connector "${id}" is not enabled`);
    }
    pick = ids;
  }
  if (!pick.length) throw badRequest('No vendor connector is enabled');
  const out = pick.map((id) => connectors.get(id));
  for (const c of out) {
    const miss = c.problems();
    if (miss.length) throw badRequest(`${c.label} is not configured: ${miss.join(', ')}`);
  }
  return out;
}

// Window for one connector: a full window when the active dataset holds no rows from a vendor pull for
// its platform, else the trailing rebuild window.
function planWindow(c) {
  const active = datasets.active();
  const today = time.now().toISOString().slice(0, 10);
  let lastDay = null;
  if (active && active.options && active.options.provider === 'vendor' && (active.options.connectors || []).includes(c.id)) {
    const p = (active.platforms || []).find((x) => x.platform === c.platform);
    if (p && p.max_date) lastDay = p.max_date;
  }
  let from = win.planFrom({
    floor: c.historyFloor(),
    monthsBack: Number(settings.get('vendors.months_back', 13)) || 13,
    rebuildDays: c.rebuildDays(),
    lastDay,
    maxDaysBack: c.maxDaysBack || null,
    today,
  });
  // A connector whose figures are whole-month totals (GitHub per-user dollars) re-reads from the month start,
  // so the carry-over cut-off is the month start and carried days never overlap a month figure.
  let align = null;
  try { align = c.describe().window_align; } catch (e) { align = null; }
  if (align === 'month') from = win.maxDate(`${from.slice(0, 7)}-01`, c.historyFloor());
  return { from, to: win.endNow(time.now()), incremental: !!lastDay };
}

// Org mapping layer (builder N). Optional until it lands; a failure here never fails the usage pull.
function ingestOrgs(vendor, orgs) {
  let oc = null;
  try { oc = require('./orgCorrelation'); } catch (e) { oc = null; }
  if (!oc || typeof oc.ingest !== 'function') {
    log('org correlation is not available; vendor orgs skipped');
    return;
  }
  try {
    oc.ingest(vendor, orgs, time.nowIso());
  } catch (e) {
    console.warn(`[vendors] org ingest for ${vendor} failed: ${e.message}`);
  }
}

function writeDetail(db, vendor, from, rows) {
  const at = time.nowIso();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO vendor_usage_detail (vendor, date, person_key, email, model, product, tokens, cost_usd, list_cost_usd, requests, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare('DELETE FROM vendor_usage_detail WHERE vendor = ? AND date >= ?').run(vendor, from);
    for (const r of rows) {
      ins.run(vendor, r.date, r.person_key, r.email || '', r.model || '', r.product || '', r.tokens, r.cost_usd, r.list_cost_usd,
        r.requests === null || r.requests === undefined ? null : Math.round(r.requests), at);
    }
  })();
}

async function pull(opts = {}) {
  if (importLock.isBusy()) {
    throw conflict(importLock.current() === 'vendors' ? 'A vendor pull is already running' : 'A Power BI pull is already running');
  }
  const chosen = chooseConnectors(opts.ids);
  importLock.tryAcquire('vendors');
  const t0 = Date.now();
  const db = getDb();
  let id = null;
  let stagedRows = 0;
  let current = null; // connector being read, for the error message
  try {
    const options = { provider: 'vendor', connectors: chosen.map((c) => c.id), from: null, to: null, asOf: null, coverage: {} };
    id = staging.createDataset({
      label: `Vendors ${chosen.map((c) => c.label).join(', ')} ${labelStamp()}`, source: 'import', options,
    });
    log(`pull started as dataset ${id} (${options.connectors.join(', ')})`);

    const activeNow = datasets.active();
    const byEmail = emailToPersonKey(activeNow ? activeNow.id : null);
    const resolve = (key, email) => {
      const e = String(email || '').trim().toLowerCase();
      if (e) return byEmail.get(e) || key;
      // No e-mail on the row (GitHub): the key is a login; match People user_id, then the e-mail local part.
      const login = String(key || '').trim().toLowerCase();
      return (login && byEmail.byLogin && byEmail.byLogin.get(login)) || key;
    };
    const usage = [];
    const byVendor = {};
    const details = [];
    const windows = {};
    for (const c of chosen) {
      current = c;
      const w = planWindow(c);
      windows[c.id] = w;
      progress('auth', { vendor: c.id, message: `${c.label}: reading ${w.from} to ${w.to.slice(0, 10)}${w.incremental ? ' (trailing window)' : ''}` });
      const r = await c.pull({
        from: w.from,
        to: w.to,
        log: (m) => log(`${c.id}: ${m}`),
        progress: (stage, extra) => progress(stage, Object.assign({}, extra || {}, { vendor: c.id })),
      });
      current = null;
      // Connectors are keyed by e-mail; People are keyed by alias. Use the alias when People knows the e-mail.
      for (const u of r.usage) u.PersonKey = resolve(u.PersonKey, u.Email);
      for (const d of r.detail) d.person_key = resolve(d.person_key, d.email);
      usage.push(...r.usage);
      details.push({ vendor: c.id, from: w.from, rows: r.detail });
      let usd = 0;
      for (const u of r.usage) usd += Number(u.CostUSD) || 0;
      const pct = r.coverage && r.coverage.org_total_usd > 0 ? Math.round((r.coverage.user_rows_usd / r.coverage.org_total_usd) * 10000) / 100 : null;
      byVendor[c.id] = {
        rows: r.usage.length, usd: Math.round(usd * 100) / 100, from: w.from, to: w.to.slice(0, 10),
        data_refreshed_at: (r.coverage && r.coverage.data_refreshed_at) || null,
        coverage: Object.assign({}, r.coverage || {}, { pct }),
      };
      options.coverage[c.id] = byVendor[c.id].coverage;
      ingestOrgs(c.id, r.orgs || { values: [] });
    }

    // Newest day any connector delivered.
    let asOf = null;
    for (const u of usage) if (!asOf || u.Date > asOf) asOf = u.Date;
    options.asOf = asOf;
    if (asOf) options.exportDate = asOf;
    options.from = Object.values(windows).map((w) => w.from).sort()[0] || null;
    options.to = Object.values(windows).map((w) => w.to.slice(0, 10)).sort().pop() || null;
    db.prepare('UPDATE datasets SET options_json = ? WHERE id = ?').run(JSON.stringify(options), id);

    // Carry-over: platforms this pull did not read keep the active dataset's rows; a trailing-window
    // platform keeps the rows before its window.
    progress('carry', { message: 'Copying platforms without a connector from the active dataset' });
    const pulled = new Map(chosen.map((c) => [c.platform, windows[c.id]]));
    for (const p of PLATFORMS) {
      const w = pulled.get(p.id);
      let rows;
      if (!w) rows = activeUsage(p.id);
      else if (w.incremental) rows = activeUsage(p.id, { before: w.from });
      else rows = [];
      if (rows.length) usage.push(...rows);
      progress('carry', { table: p.id, rows: rows.length, message: `${p.name}: ${rows.length} rows${w ? ' before the pulled window' : ' copied'}` });
    }

    progress('people', { table: 'people', rows: 0, message: 'Copying people from the active dataset' });
    const people = activeCopy('people');
    progress('people', { table: 'people', rows: people.length, message: `${people.length} people rows (copied from the active dataset)` });
    const lookups = {};
    for (const key of ['seat_rate', 'region_map', 'lob_cg_map']) {
      lookups[key] = activeCopy(key);
      progress('lookups', { table: key, rows: lookups[key].length, message: `${lookups[key].length} rows (copied from the active dataset)` });
    }

    stagedRows = usage.length;
    staging.loadTables(id, { usage, people, seatRate: lookups.seat_rate, regionMap: lookups.region_map, lobCgMap: lookups.lob_cg_map });
    progress('normalize', { rows: stagedRows, message: 'Normalizing' });
    normalize(id);
    progress('verify', { rows: stagedRows, message: 'Verifying' });
    const run = datasets.verify(id);
    for (const d of details) writeDetail(db, d.vendor, d.from, d.rows);

    const want = opts.promote === undefined ? !!settings.get('vendors.auto_promote', true) : !!opts.promote;
    let promoted = false;
    if (want && run.verdict !== 'fail') {
      progress('promote', { rows: stagedRows, message: 'Promoting' });
      datasets.promote(id);
      datasets.purge();
      promoted = true;
    }
    const result = { dataset_id: id, verdict: run.verdict, promoted, rows: stagedRows, duration_ms: Date.now() - t0, by_vendor: byVendor };
    saveLastPull({
      dataset_id: id, verdict: run.verdict, rows: result.rows, duration_ms: result.duration_ms, error: null, by_vendor: byVendor,
    });
    progress('done', { rows: result.rows, message: promoted ? 'Pull promoted' : `Pull finished, not promoted (verdict ${run.verdict})` });
    log(`pull finished: dataset ${id}, ${result.rows} rows, verdict ${run.verdict}, promoted ${promoted}`);
    return result;
  } catch (e) {
    const base = e && e.message ? e.message : String(e);
    const msg = current ? `${current.label}: ${base}` : base;
    console.warn(`[vendors] pull failed: ${msg}`);
    if (id !== null) {
      try { db.prepare("UPDATE datasets SET status = 'failed', note = ? WHERE id = ?").run(msg, id); } catch (e2) { /* keep the original error */ }
    }
    try {
      saveLastPull({ dataset_id: id, verdict: null, rows: stagedRows, duration_ms: Date.now() - t0, error: msg, by_vendor: {} });
    } catch (e2) { /* ignore */ }
    progress('error', { vendor: current ? current.id : null, message: msg });
    if (current && e instanceof HttpError) {
      const wrapped = new HttpError(e.status, msg, e.code);
      throw wrapped;
    }
    throw current ? Object.assign(new HttpError(500, msg), { cause: e }) : e;
  } finally {
    importLock.release('vendors');
  }
}

module.exports = { pull, isRunning, planWindow, chooseConnectors };
