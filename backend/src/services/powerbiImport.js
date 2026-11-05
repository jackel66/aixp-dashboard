'use strict';
// Power BI pull: chunked DAX queries -> staging -> normalize -> verify -> promote (CONTRACT section 13).
const { getDb } = require('../db');
const settings = require('./settings');
const client = require('./powerbiClient');
const staging = require('./staging');
const { normalize, parseDate } = require('./normalize');
const datasets = require('./datasets');
const { broadcast } = require('./events');
const time = require('./time');
const { conflict, badRequest, HttpError } = require('../errors');
const { activeCopy } = require('./activeCopy');
const importLock = require('./importLock');

const isDax = (s) => /^evaluate\b/i.test(String(s || '').trim());
const tq = (name) => `'${String(name).replace(/'/g, "''")}'`; // quoted DAX table name
const sq = (s) => `"${String(s).replace(/"/g, '""')}"`; // DAX string literal
const PLATFORM_COLUMN = 'Platform';

function progress(stage, extra) {
  broadcast('import.progress', Object.assign({ stage, table: null, chunk: null, rows: null, message: '' }, extra || {}));
}

// True while ANY import (Power BI or vendor) holds the shared lock.
function isRunning() { return importLock.isBusy(); }

// ---- configuration -----------------------------------------------------------------------

function problems() {
  const c = client.cfg();
  const out = [];
  if (c.authMode === 'token') {
    if (!c.token) out.push('bearer token');
  } else {
    if (!c.tenant) out.push('tenant id');
    if (!c.clientId) out.push('client id');
    if (!c.secret) out.push('client secret');
  }
  if (!c.workspace) out.push('workspace id');
  if (!c.dataset) out.push('dataset id');
  return out;
}

function isConfigured() { return problems().length === 0; }

function tablesConfig() {
  const t = settings.get('powerbi.tables', {}) || {};
  return {
    usage: String(t.usage || '').trim(), people: String(t.people || '').trim(), seat_rate: String(t.seat_rate || '').trim(),
    region_map: String(t.region_map || '').trim(), lob_cg_map: String(t.lob_cg_map || '').trim(),
  };
}

const dateColumn = () => String(settings.get('powerbi.date_column', 'Date') || 'Date');
const firstValue = (row) => (row && typeof row === 'object' ? Object.values(row)[0] : undefined);

// ---- test --------------------------------------------------------------------------------

async function test() {
  const out = {
    ok: false,
    auth: { ok: false }, workspace: { ok: false }, dataset: { ok: false }, tables: [], latest: { usage_max_date: null },
  };
  const miss = problems().filter((p) => p !== 'dataset id');
  const skipped = (msg) => ({ ok: false, error: msg });
  if (miss.length) {
    out.auth = skipped(`Not configured: ${miss.join(', ')}`);
    out.workspace = skipped('Not checked');
    out.dataset = skipped('Not checked');
    return out;
  }
  try {
    const t = await client.getToken();
    out.auth = { ok: true, expires_in: t.expires_in };
  } catch (e) {
    out.auth = skipped(e.message);
    out.workspace = skipped('Not checked: sign-in failed');
    out.dataset = skipped('Not checked: sign-in failed');
    return out;
  }
  let list = null;
  try {
    list = await client.listDatasets();
    out.workspace = { ok: true, name: await client.workspaceName() };
  } catch (e) {
    out.workspace = skipped(e.message);
    out.dataset = skipped('Not checked: workspace is not reachable');
    return out;
  }
  const c = client.cfg();
  const found = list.find((d) => d.id.toLowerCase() === c.dataset.toLowerCase());
  if (!c.dataset) out.dataset = skipped('powerbi.dataset_id is not set');
  else if (found) out.dataset = { ok: true, name: found.name };
  else out.dataset = skipped('The dataset id is not in this workspace');
  if (!out.dataset.ok) return out;

  const tables = tablesConfig();
  for (const key of ['usage', 'people', 'seat_rate', 'region_map', 'lob_cg_map']) {
    const name = tables[key];
    if (!name) { out.tables.push({ key, name: '', ok: true, skipped: true, rows: null }); continue; }
    try {
      let rows;
      if (isDax(name)) rows = (await client.executeQuery(name)).length;
      else rows = Number(firstValue((await client.executeQuery(`EVALUATE ROW("n", COUNTROWS(${tq(name)}))`))[0]));
      out.tables.push({ key, name, ok: true, rows: Number.isFinite(rows) ? rows : 0 });
    } catch (e) {
      out.tables.push({ key, name, ok: false, error: e.message });
    }
  }
  if (tables.usage && !isDax(tables.usage)) {
    try {
      const r = await client.executeQuery(`EVALUATE ROW("d", MAX(${tq(tables.usage)}[${dateColumn()}]))`);
      out.latest.usage_max_date = parseDate(firstValue(r[0]));
    } catch (e) { /* the table row already reports the failure */ }
  }
  out.ok = out.auth.ok && out.workspace.ok && out.dataset.ok && out.tables.every((t) => t.ok);
  return out;
}

// ---- chunked usage pull ------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
function monthStart(y, m) { const d = new Date(Date.UTC(y, m - 1, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, 1]; }
const dax3 = (t) => `DATE(${t[0]},${t[1]},${t[2]})`;

function monthsFor(asOf, monthsBack) {
  const [y, m] = asOf.split('-').map(Number);
  const out = [];
  for (let i = monthsBack; i >= 0; i--) {
    const s = monthStart(y, m - i);
    out.push({ key: `${s[0]}-${pad(s[1])}`, from: s, to: monthStart(s[0], s[1] + 1) });
  }
  return out;
}

function sliceQuery(tbl, dc, from, to, platform) {
  const col = `${tq(tbl)}[${dc}]`;
  let f = `${col} >= ${dax3(from)} && ${col} < ${dax3(to)}`;
  if (platform !== null) f += `, ${tq(tbl)}[${PLATFORM_COLUMN}] = ${sq(platform)}`;
  return f;
}

// One slice. A slice that answers with the row cap is split: month -> platform -> half month -> error.
async function pullSlice(ctx, from, to, platform, half, label) {
  if (ctx.failed) throw new Error('Pull stopped after an earlier chunk failed');
  const filter = sliceQuery(ctx.tbl, ctx.dc, from, to, platform);
  const rows = await client.executeQuery(`EVALUATE CALCULATETABLE(${tq(ctx.tbl)}, ${filter})`);
  if (!client.isCapped(rows)) {
    ctx.rows += rows.length;
    progress('usage', { table: 'usage', chunk: label, rows: ctx.rows, message: `${label}: ${rows.length} rows` });
    return rows;
  }
  if (platform === null) {
    // Rows with a blank platform cannot be selected by value; normalize would reject them anyway.
    const d = await client.executeQuery(
      `EVALUATE CALCULATETABLE(DISTINCT(${tq(ctx.tbl)}[${PLATFORM_COLUMN}]), ${sliceQuery(ctx.tbl, ctx.dc, from, to, null)})`
    );
    const names = d.map((r) => firstValue(r)).filter((v) => v !== null && v !== undefined && String(v) !== '');
    const parts = await Promise.all(names.map((n) => pullSlice(ctx, from, to, String(n), null, `${label}/${n}`)));
    return [].concat(...parts);
  }
  if (half === null) {
    const mid = [from[0], from[1], 16];
    const a = await Promise.all([
      pullSlice(ctx, from, mid, platform, 1, `${label}/1-15`),
      pullSlice(ctx, mid, to, platform, 2, `${label}/16-end`),
    ]);
    return [].concat(...a);
  }
  throw new HttpError(502, `Power BI slice ${label} still returns the ${client.getRowCap()} row limit after splitting by half month; narrow the Usage DAX query`);
}

async function pullUsage(ctx, usageName, monthsBack) {
  if (isDax(usageName)) {
    const rows = await client.executeQuery(usageName);
    if (client.isCapped(rows)) throw new HttpError(502, `The Usage DAX query returned the ${client.getRowCap()} row limit; filter it to fewer rows`);
    ctx.rows = rows.length;
    progress('usage', { table: 'usage', chunk: 'query', rows: ctx.rows, message: `${rows.length} rows` });
    let asOf = null;
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (staging.headerKey(k) === 'date') { const d = parseDate(r[k]); if (d && (!asOf || d > asOf)) asOf = d; }
      }
    }
    return { rows, asOf };
  }
  ctx.tbl = usageName;
  ctx.dc = dateColumn();
  const r = await client.executeQuery(`EVALUATE ROW("d", MAX(${tq(usageName)}[${ctx.dc}]))`);
  const asOf = parseDate(firstValue(r[0]));
  if (!asOf) throw new HttpError(502, `The ${usageName} table has no rows or no valid ${ctx.dc} values`);
  progress('usage', { table: 'usage', chunk: 'as-of', rows: 0, message: `Latest usage date ${asOf}` });
  const months = monthsFor(asOf, monthsBack);
  const parts = await Promise.all(months.map((mo) => pullSlice(ctx, mo.from, mo.to, null, null, mo.key).catch((e) => { ctx.failed = true; throw e; })));
  return { rows: [].concat(...parts), asOf };
}

async function pullWhole(name, label) {
  const rows = await client.executeQuery(isDax(name) ? name : `EVALUATE ${tq(name)}`);
  if (client.isCapped(rows)) throw new HttpError(502, `${label} returned the ${client.getRowCap()} row limit; use a DAX query that returns fewer rows`);
  return rows;
}

// ---- pull --------------------------------------------------------------------------------

function labelStamp() {
  const d = time.now();
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: time.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${time.todayPhoenix(d)} ${hm}`;
}

function saveLastPull(summary) {
  settings.set('powerbi.last_pull_at', time.nowIso());
  settings.set('powerbi.last_pull', summary);
  broadcast('settings.changed', { keys: ['powerbi.last_pull_at', 'powerbi.last_pull'] });
}

async function pull(opts = {}) {
  if (importLock.isBusy()) {
    throw conflict(importLock.current() === 'powerbi' ? 'A Power BI pull is already running' : 'A vendor pull is already running');
  }
  const miss = problems();
  if (miss.length) throw badRequest(`Power BI is not configured: ${miss.join(', ')}`);
  const tables = tablesConfig();
  if (!tables.usage) throw badRequest('powerbi.tables.usage is required');
  importLock.tryAcquire('powerbi');
  const t0 = Date.now();
  const db = getDb();
  let id = null;
  const ctx = { rows: 0, tbl: null, dc: null };
  try {
    const name = String(settings.get('powerbi.dataset_name', '') || '') || client.cfg().dataset;
    const monthsBack = Number(settings.get('powerbi.months_back', 13)) || 13;
    const options = { provider: 'powerbi', dataset_name: name, months_back: monthsBack, asOf: null };
    id = staging.createDataset({ label: `Power BI ${name} ${labelStamp()}`, source: 'import', options });
    console.log(`[powerbi] pull started as dataset ${id}`);

    progress('auth', { message: 'Signing in' });
    await client.getToken();

    const usage = await pullUsage(ctx, tables.usage, monthsBack);
    options.asOf = usage.asOf;
    if (usage.asOf) options.exportDate = usage.asOf;
    db.prepare('UPDATE datasets SET options_json = ? WHERE id = ?').run(JSON.stringify(options), id);

    progress('people', { table: 'people', rows: 0, message: 'Reading people' });
    const people = tables.people ? await pullWhole(tables.people, 'People') : activeCopy('people');
    progress('people', { table: 'people', rows: people.length, message: `${people.length} people rows${tables.people ? '' : ' (copied from the active dataset)'}` });

    const lookups = {};
    for (const key of ['seat_rate', 'region_map', 'lob_cg_map']) {
      progress('lookups', { table: key, rows: null, message: `Reading ${key}` });
      lookups[key] = tables[key] ? await pullWhole(tables[key], key) : activeCopy(key);
      progress('lookups', { table: key, rows: lookups[key].length, message: `${lookups[key].length} rows${tables[key] ? '' : ' (copied from the active dataset)'}` });
    }

    staging.loadTables(id, {
      usage: usage.rows, people, seatRate: lookups.seat_rate, regionMap: lookups.region_map, lobCgMap: lookups.lob_cg_map,
    });
    progress('normalize', { rows: usage.rows.length, message: 'Normalizing' });
    normalize(id);
    progress('verify', { rows: usage.rows.length, message: 'Verifying' });
    const run = datasets.verify(id);
    const want = opts.promote === undefined ? !!settings.get('powerbi.auto_promote', true) : !!opts.promote;
    let promoted = false;
    if (want && run.verdict !== 'fail') {
      progress('promote', { rows: usage.rows.length, message: 'Promoting' });
      datasets.promote(id);
      datasets.purge();
      promoted = true;
    }
    const result = { dataset_id: id, verdict: run.verdict, promoted, rows: usage.rows.length, duration_ms: Date.now() - t0 };
    saveLastPull({ dataset_id: id, verdict: run.verdict, rows: result.rows, duration_ms: result.duration_ms, error: null });
    progress('done', { rows: result.rows, message: promoted ? 'Pull promoted' : `Pull finished, not promoted (verdict ${run.verdict})` });
    console.log(`[powerbi] pull finished: dataset ${id}, ${result.rows} rows, verdict ${run.verdict}, promoted ${promoted}`);
    return result;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.warn(`[powerbi] pull failed: ${msg}`);
    if (id !== null) {
      try { db.prepare("UPDATE datasets SET status = 'failed', note = ? WHERE id = ?").run(msg, id); } catch (e2) { /* keep the original error */ }
    }
    try { saveLastPull({ dataset_id: id, verdict: null, rows: ctx.rows, duration_ms: Date.now() - t0, error: msg }); } catch (e2) { /* ignore */ }
    progress('error', { message: msg });
    throw e;
  } finally {
    importLock.release('powerbi');
  }
}

module.exports = { test, pull, isRunning, isConfigured, problems, monthsFor };
