'use strict';
// Report queries behind the GET routes. Everything reads rollup_* tables except: the user detail
// model split and activity (usage), the Copilot gross/discount/net block (usage, the rollups carry
// no discount columns) and distinct users per model (usage, the rollups only keep per-day distinct counts).
const M = require('./measures');
const settings = require('./settings');
const time = require('./time');
const platformsMod = require('../platforms');
const { CHECKS } = require('./verify');
const { badRequest, notFound } = require('../errors');

const { round2, num, inList } = M;

const unitOf = (id) => (platformsMod.byId(id) || {}).unit || 'units';
const cons = (id, v) => ({ value: round2(v), unit: unitOf(id) });
const pad2 = (n) => String(n).padStart(2, '0');

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

// ---- verification helpers (shared with the routes) -----------------------------------------

function latestRun(db, datasetId) {
  return db.prepare('SELECT * FROM verification_runs WHERE dataset_id = ? ORDER BY id DESC LIMIT 1').get(datasetId) || null;
}

function runShape(r) {
  return {
    id: r.id, dataset_id: r.dataset_id, ran_at: r.ran_at, verdict: r.verdict, fail: r.fail_count, warn: r.warn_count,
    info: r.info_count, pass: r.pass_count,
  };
}

function checkShape(r, withEvidence) {
  const meta = CHECKS.find((c) => c.id === r.check_id);
  const out = {
    id: r.check_id, title: r.title, severity: r.severity, status: r.status, platform: r.platform || null,
    message: r.message, metrics: parseJson(r.metrics_json, {}), meaning: meta ? meta.meaning : '', affected: r.affected || 0,
  };
  if (withEvidence) out.evidence = parseJson(r.evidence_json, { columns: [], rows: [], total: 0 });
  return out;
}

// ---- summary -------------------------------------------------------------------------------

function windowSpend(ctx, seat, from, to, ids) {
  const c = M.consumptionByPlatform(ctx, from, to, ids);
  let cons_ = 0;
  let seat_ = 0;
  for (const id of ids) {
    cons_ += c[id].usd;
    seat_ += seat.between(id, from, to);
  }
  return M.spendTriple(cons_, seat_);
}

function summary(query) {
  const ctx = M.resolve(query);
  const { db } = ctx;
  const seat = M.loadSeat(ctx);
  const dates = M.platformDates(ctx);
  const ids = ctx.platforms;
  const stale = num(settings.get('verify.stale_days', 5));

  let hp;
  let pp;
  if (ctx.explicitRange) {
    hp = { from: ctx.from, to: ctx.to, label: `${M.dateLong(ctx.from)} to ${M.dateLong(ctx.to)}` };
    const prev = M.previousWindow(ctx.from, ctx.to);
    pp = { from: prev.from, to: prev.to, label: `${prev.days} days before` };
  } else {
    const ym = M.monthOf(ctx.to);
    hp = { from: `${ym}-01`, to: ctx.to, label: `${M.monthName(ym)} to date` };
    const pym = M.addMonths(ym, -1);
    const day = Math.min(Number(ctx.to.slice(8)), M.daysInMonth(pym));
    pp = { from: `${pym}-01`, to: `${pym}-${pad2(day)}`, label: `${M.monthName(pym)}, same days` };
  }

  const c = M.consumptionByPlatform(ctx, ctx.from, ctx.to, ids);
  const au = M.activeUsers(ctx, ctx.from, ctx.to, ids);
  const supported = {};
  for (const r of db.prepare(
    "SELECT platform, count(DISTINCT model) AS n FROM rollup_model_day WHERE dataset_id = ? AND model <> '' GROUP BY platform"
  ).all(ctx.datasetId)) supported[r.platform] = r.n;

  const sparkFrom = time.addDays(ctx.asOf, -29);
  const spark = {};
  for (const id of ids) spark[id] = {};
  for (const r of db.prepare(
    `SELECT platform, date, cost_usd FROM rollup_platform_day
     WHERE dataset_id = ? AND date >= ? AND platform IN (${inList(ids)})`
  ).all(ctx.datasetId, sparkFrom)) spark[r.platform][r.date] = r.cost_usd;

  let totCons = 0;
  let totSeat = 0;
  const platforms = ids.map((id) => {
    const p = platformsMod.byId(id);
    const d = dates[id];
    const seatUsd = seat.between(id, ctx.from, ctx.to);
    totCons += c[id].usd;
    totSeat += seatUsd;
    const asOfP = d ? d.max : null;
    const lag = asOfP ? time.diffDays(asOfP, ctx.asOf) : null;
    const sp = [];
    for (let i = 0; i < 30; i += 1) {
      const date = time.addDays(sparkFrom, i);
      sp.push({ date, usd: round2(spark[id][date] || 0) });
    }
    return {
      id, name: p.name, unit: p.unit, as_of: asOfP, lag_days: lag, stale: lag === null ? true : lag > stale,
      rows: c[id].rows, spend: M.spendTriple(c[id].usd, seatUsd), consumption: cons(id, c[id].consumption),
      active_users: au.byPlatform[id], models_supported: supported[id] || 0, spark: sp,
    };
  });

  const run = latestRun(db, ctx.datasetId);
  let confidence = {
    verdict: 'unknown', fail: 0, warn: 0, info: 0, pass: 0, run_id: null, ran_at: null, first_failing: null,
  };
  if (run) {
    const ff = db.prepare(
      `SELECT check_id, title FROM verification_results WHERE run_id = ? AND status = 'fail' AND severity IN ('fail', 'warn')
       ORDER BY CASE severity WHEN 'fail' THEN 0 ELSE 1 END, id LIMIT 1`
    ).get(run.id);
    confidence = {
      verdict: run.verdict, fail: run.fail_count, warn: run.warn_count, info: run.info_count, pass: run.pass_count,
      run_id: run.id, ran_at: run.ran_at, first_failing: ff ? { id: ff.check_id, title: ff.title } : null,
    };
  }

  const ds = ctx.ds;
  const usageRows = (ds.platforms || []).reduce((a, p) => a + num(p.rows), 0);
  const peopleCount = ds.counts && ds.counts.people !== undefined
    ? ds.counts.people
    : db.prepare('SELECT count(*) AS n FROM people WHERE dataset_id = ?').get(ds.id).n;
  return {
    asOf: ctx.asOf,
    dataset: {
      id: ds.id, label: ds.label, source: ds.source, seed: ds.seed, promoted_at: ds.promoted_at, verdict: ds.verdict,
      counts: { usage_rows: usageRows, people: peopleCount, platforms: (ds.platforms || []).length },
    },
    range: { from: ctx.from, to: ctx.to },
    seat: { basis: seat.mode, estimate: seat.estimate },
    headline: {
      period: hp,
      spend: windowSpend(ctx, seat, hp.from, hp.to, ids),
      prior: { period: pp, spend: windowSpend(ctx, seat, pp.from, pp.to, ids) },
    },
    platforms,
    totals: { spend: M.spendTriple(totCons, totSeat), active_users: au.total },
    confidence,
    caveat: platformsMod.CAVEAT,
  };
}

// ---- trend ---------------------------------------------------------------------------------

function applyTrendDefaults(ctx, grain) {
  if (ctx.explicitFrom) return;
  if (grain === 'week') ctx.from = time.mondayOf(time.addDays(ctx.to, -77));
  else if (grain === 'month') ctx.from = `${M.addMonths(M.monthOf(ctx.to), -11)}-01`;
  if (ctx.from > ctx.to) ctx.from = ctx.to;
}

// Buckets of [{start, label, platforms: {id: {usd, active_users, consumption}}, total_usd, active_users}]
function buildBuckets(ctx, seat, grain, ids) {
  const B = M.BUCKET_SQL[grain];
  const list = ids.length ? inList(ids) : "''";
  const cell = new Map();
  for (const r of ctx.db.prepare(
    `SELECT ${B('date')} AS b, platform, sum(cost_usd) AS usd, sum(consumption) AS cons FROM rollup_platform_day
     WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${list}) GROUP BY b, platform`
  ).all(ctx.datasetId, ctx.from, ctx.to)) cell.set(`${r.b}|${r.platform}`, r);
  const auCell = new Map();
  for (const r of ctx.db.prepare(
    `SELECT ${B('pd.date')} AS b, pd.platform, count(DISTINCT pd.person_key) AS n FROM rollup_person_day pd
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${list}) AND ${M.ACT} GROUP BY b, pd.platform`
  ).all(ctx.datasetId, ctx.from, ctx.to)) auCell.set(`${r.b}|${r.platform}`, r.n);
  const auAll = new Map();
  for (const r of ctx.db.prepare(
    `SELECT ${B('pd.date')} AS b, count(DISTINCT pd.person_key) AS n FROM rollup_person_day pd
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${list}) AND ${M.ACT} GROUP BY b`
  ).all(ctx.datasetId, ctx.from, ctx.to)) auAll.set(r.b, r.n);

  return M.bucketList(grain, ctx.from, ctx.to).map((start) => {
    const a = start > ctx.from ? start : ctx.from;
    const bEnd = M.bucketEnd(grain, start);
    const e = bEnd < ctx.to ? bEnd : ctx.to;
    const platforms = {};
    let total = 0;
    for (const id of ids) {
      const row = cell.get(`${start}|${id}`);
      const consUsd = row ? num(row.usd) : 0;
      const seatUsd = ctx.basis === 'consumption' ? 0 : seat.between(id, a, e);
      const usd = round2(M.pickBasis(ctx.basis, consUsd, seatUsd));
      total += usd;
      platforms[id] = { usd, active_users: auCell.get(`${start}|${id}`) || 0, consumption: cons(id, row ? row.cons : 0) };
    }
    return {
      start, label: M.bucketLabel(grain, start), platforms, total_usd: round2(total), active_users: auAll.get(start) || 0,
    };
  });
}

function trend(query) {
  const grain = M.first((query || {}).grain) || 'week';
  if (!M.GRAINS.includes(grain)) throw badRequest('grain must be day, week or month');
  const ctx = M.resolve(query);
  applyTrendDefaults(ctx, grain);
  const seat = M.loadSeat(ctx);
  return {
    asOf: ctx.asOf, grain, from: ctx.from, to: ctx.to, basis: ctx.basis,
    buckets: buildBuckets(ctx, seat, grain, ctx.platforms),
  };
}

// ---- models --------------------------------------------------------------------------------

function tokenIds(ids) {
  return ids.filter((id) => platformsMod.byId(id).models);
}

function modelRows(ctx, ids) {
  const tids = tokenIds(ids);
  if (!tids.length) return [];
  const rows = ctx.db.prepare(
    `SELECT platform, model, sum(cost_usd) AS usd, sum(consumption) AS cons, sum(requests) AS req
     FROM rollup_model_day WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${inList(tids)}) AND model <> ''
     GROUP BY platform, model`
  ).all(ctx.datasetId, ctx.from, ctx.to);
  const users = new Map();
  for (const r of ctx.db.prepare(
    `SELECT platform, model, count(DISTINCT person_key) AS n FROM usage
     WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${inList(tids)}) AND model <> ''
       AND (coalesce(cost_usd, 0) > 0 OR coalesce(tokens, 0) > 0 OR coalesce(credits, 0) > 0)
     GROUP BY platform, model`
  ).all(ctx.datasetId, ctx.from, ctx.to)) users.set(`${r.platform}|${r.model}`, r.n);
  const total = rows.reduce((a, r) => a + num(r.usd), 0);
  return rows
    .map((r) => ({
      platform: r.platform, model: r.model, usd: round2(r.usd), consumption: cons(r.platform, r.cons),
      requests: Math.round(num(r.req)), users: users.get(`${r.platform}|${r.model}`) || 0,
      share: total > 0 ? num(r.usd) / total : 0, cost_per_unit: num(r.cons) > 0 ? num(r.usd) / num(r.cons) : null,
    }))
    .sort((a, b) => b.usd - a.usd);
}

function models(query) {
  const ctx = M.resolve(query);
  return { asOf: ctx.asOf, rows: modelRows(ctx, ctx.platforms) };
}

function topUsersFromUsage(ctx, platform, model, limit) {
  return ctx.db.prepare(
    `SELECT u.person_key, sum(u.cost_usd) AS usd, sum(u.consumption) AS cons, p.display_name, p.lob_cg
     FROM usage u LEFT JOIN people p ON p.dataset_id = u.dataset_id AND p.person_key = u.person_key
     WHERE u.dataset_id = ? AND u.date BETWEEN ? AND ? AND u.platform = ? AND u.model = ?
     GROUP BY u.person_key ORDER BY usd DESC LIMIT ?`
  ).all(ctx.datasetId, ctx.from, ctx.to, platform, model, limit).map((r) => ({
    person_key: r.person_key, display_name: r.display_name || r.person_key, lob_cg: r.lob_cg || 'Unmatched usage',
    usd: round2(r.usd), consumption: cons(platform, r.cons),
  }));
}

function modelDetail(platform, model, query) {
  const p = platformsMod.byId(platform);
  if (!p) throw notFound('Platform');
  if (!p.models) throw notFound('Model');
  const ctx = M.resolve(query);
  const row = modelRows(ctx, [platform]).find((r) => r.model === model);
  if (!row) throw notFound('Model');
  // 12 weekly buckets ending in the week of "to"
  const lastWeek = time.mondayOf(ctx.to);
  const firstWeek = time.addDays(lastWeek, -77);
  const B = M.BUCKET_SQL.week;
  const got = new Map();
  for (const r of ctx.db.prepare(
    `SELECT ${B('date')} AS b, sum(cost_usd) AS usd FROM rollup_model_day
     WHERE dataset_id = ? AND platform = ? AND model = ? AND date BETWEEN ? AND ? GROUP BY b`
  ).all(ctx.datasetId, platform, model, firstWeek, ctx.to)) got.set(r.b, r.usd);
  const trendRows = [];
  for (let i = 0; i < 12; i += 1) {
    const start = time.addDays(firstWeek, i * 7);
    trendRows.push({ start, usd: round2(got.get(start) || 0) });
  }
  return {
    asOf: ctx.asOf, platform, model, usd: row.usd, consumption: row.consumption, requests: row.requests, users: row.users,
    trend: trendRows, top_users: topUsersFromUsage(ctx, platform, model, 10),
  };
}

// ---- platform page -------------------------------------------------------------------------

function gapsFor(ctx, id, cFrom, cTo) {
  if (cFrom > cTo) return [];
  const present = new Set(ctx.db.prepare(
    'SELECT date FROM rollup_platform_day WHERE dataset_id = ? AND platform = ? AND date BETWEEN ? AND ?'
  ).all(ctx.datasetId, id, cFrom, cTo).map((r) => r.date));
  const weekend = !!ctx.db.prepare(
    "SELECT 1 FROM rollup_platform_day WHERE dataset_id = ? AND platform = ? AND strftime('%w', date) IN ('0', '6') LIMIT 1"
  ).get(ctx.datasetId, id);
  const gaps = [];
  let cur = null;
  for (let d = cFrom; d <= cTo; d = time.addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    const counts = weekend || (wd !== 0 && wd !== 6);
    if (!counts) continue;
    if (present.has(d)) {
      if (cur) { gaps.push(cur); cur = null; }
    } else if (cur) {
      cur.to = d;
      cur.days += 1;
    } else {
      cur = { from: d, to: d, days: 1 };
    }
  }
  if (cur) gaps.push(cur);
  return gaps;
}

function platformReport(id, query) {
  const p = platformsMod.byId(id);
  if (!p) throw notFound('Platform');
  const ctx = M.resolve(query);
  ctx.platforms = [id];
  const { db } = ctx;
  const seat = M.loadSeat(ctx);
  const dates = M.platformDates(ctx)[id] || null;
  const stale = num(settings.get('verify.stale_days', 5));
  const asOfP = dates ? dates.max : null;
  const lag = asOfP ? time.diffDays(asOfP, ctx.asOf) : null;

  let coverage = { from: ctx.from, to: ctx.from, days: 0, gaps: [] };
  if (dates) {
    const cFrom = ctx.from > dates.min ? ctx.from : dates.min;
    const cTo = ctx.to < dates.max ? ctx.to : dates.max;
    coverage = cFrom > cTo
      ? { from: cFrom, to: cFrom, days: 0, gaps: [] }
      : { from: cFrom, to: cTo, days: time.diffDays(cFrom, cTo) + 1, gaps: gapsFor(ctx, id, cFrom, cTo) };
  }

  const c = M.consumptionByPlatform(ctx, ctx.from, ctx.to, [id])[id];
  const prevW = M.previousWindow(ctx.from, ctx.to);
  const cPrev = M.consumptionByPlatform(ctx, prevW.from, prevW.to, [id])[id];
  const au = M.activeUsers(ctx, ctx.from, ctx.to, [id]);

  let spu = { valid: false, usd: null, unit: p.unit };
  if (p.unit === 'tokens' && p.models) {
    const r = db.prepare(
      `SELECT sum(cost_usd) AS usd, sum(tokens) AS tokens FROM rollup_model_day
       WHERE dataset_id = ? AND platform = ? AND date BETWEEN ? AND ? AND cost_usd > 0 AND tokens > 0`
    ).get(ctx.datasetId, id, ctx.from, ctx.to);
    if (r && num(r.tokens) > 0 && num(r.usd) > 0) spu = { valid: true, usd: num(r.usd) / num(r.tokens), unit: p.unit };
  }

  let github = null;
  if (id === 'github') {
    const g = db.prepare(
      `SELECT sum(cost_usd) AS gross, sum(discount_amount) AS discount, sum(net_amount) AS net FROM usage
       WHERE dataset_id = ? AND platform = 'github' AND date BETWEEN ? AND ?`
    ).get(ctx.datasetId, ctx.from, ctx.to);
    github = { gross: round2(g.gross), discount: round2(g.discount), net: round2(g.net) };
  }
  const cowork = id === 'cowork'
    ? { rate: num(settings.get('cowork.rate', 0.008)), confirmed: settings.get('cowork.rate_confirmed', false) === true }
    : null;

  const wctx = Object.assign({}, ctx);
  if (!ctx.explicitFrom) wctx.from = ctx.from;
  const trendBuckets = buildBuckets(wctx, seat, 'week', [id]).map((b) => ({
    start: b.start, usd: b.platforms[id].usd, consumption: b.platforms[id].consumption, active_users: b.platforms[id].active_users,
  }));

  const top = db.prepare(
    `SELECT pd.person_key, sum(pd.cost_usd) AS usd, sum(pd.consumption) AS cons, p.display_name, p.lob_cg
     FROM rollup_person_day pd LEFT JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.platform = ? AND pd.date BETWEEN ? AND ?
     GROUP BY pd.person_key ORDER BY usd DESC LIMIT 20`
  ).all(ctx.datasetId, id, ctx.from, ctx.to).map((r) => ({
    person_key: r.person_key, display_name: r.display_name || r.person_key, lob_cg: r.lob_cg || 'Unmatched usage',
    usd: round2(r.usd), consumption: cons(id, r.cons),
  }));

  let checks = [];
  const run = latestRun(db, ctx.datasetId);
  if (run) {
    checks = db.prepare(
      `SELECT * FROM verification_results WHERE run_id = ? AND (platform = ? OR (platform IS NULL AND status = 'fail')) ORDER BY id`
    ).all(run.id, id).map((r) => checkShape(r, false));
  }

  return {
    asOf: ctx.asOf,
    platform: { id, name: p.name, unit: p.unit, models_supported: p.models ? modelRows(ctx, [id]).length : 0 },
    as_of: asOfP, lag_days: lag, stale: lag === null ? true : lag > stale, coverage,
    spend: M.spendTriple(c.usd, seat.between(id, ctx.from, ctx.to)),
    prior: { spend: M.spendTriple(cPrev.usd, seat.between(id, prevW.from, prevW.to)) },
    consumption: cons(id, c.consumption), active_users: au.byPlatform[id], spend_per_unit: spu, github, cowork,
    trend: trendBuckets, models: p.models ? modelRows(ctx, [id]).map((m) => ({
      model: m.model, usd: m.usd, consumption: m.consumption, users: m.users, share: m.share,
    })) : [],
    top_users: top, checks,
  };
}

// ---- organization --------------------------------------------------------------------------

const DIMS = { lob_cg: 'lob_cg', region: 'region', sbl: 'sbl', person_type: 'person_type' };
const MEASURES = ['spend', 'users', 'units'];
const UNASSIGNED_VALUES = new Set(['', 'unassigned', 'unknown']);

function slug(v) {
  return String(v).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

// value -> stable key. Built from every distinct people value in the dataset so keys do not move with the range.
function keyMap(ctx, col) {
  const vals = ctx.db.prepare(`SELECT DISTINCT ${col} AS v FROM people WHERE dataset_id = ? ORDER BY ${col}`).all(ctx.datasetId).map((r) => r.v);
  const map = new Map();
  const used = new Set(['__unassigned__', '__unmatched__']);
  for (const v of vals) {
    if (v === null || UNASSIGNED_VALUES.has(String(v).trim().toLowerCase())) continue;
    let k = slug(v);
    let n = 2;
    while (used.has(k)) { k = `${slug(v)}-${n}`; n += 1; }
    used.add(k);
    map.set(v, k);
  }
  return map;
}

function rowKeyFor(map, un, v) {
  if (un) return '__unmatched__';
  if (v === null || v === undefined || UNASSIGNED_VALUES.has(String(v).trim().toLowerCase())) return '__unassigned__';
  return map.get(v) || slug(v);
}

function orgParams(query) {
  const dim = M.first((query || {}).dim) || 'lob_cg';
  if (!DIMS[dim]) throw badRequest('dim must be lob_cg, region, sbl or person_type');
  const measure = M.first((query || {}).measure) || 'spend';
  if (!MEASURES.includes(measure)) throw badRequest('measure must be spend, users or units');
  return { dim, measure };
}

function organization(query) {
  const { dim, measure } = orgParams(query);
  const ctx = M.resolve(query);
  const { db } = ctx;
  const col = DIMS[dim];
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const map = keyMap(ctx, col);
  const sortExpr = dim === 'lob_cg' ? 'min(p.lob_cg_sort)' : '0';
  const list = inList(ids);
  const base = `FROM rollup_person_day pd
     LEFT JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${list})`;
  const cells = db.prepare(
    `SELECT (p.person_key IS NULL) AS un, p.${col} AS v, ${sortExpr} AS s, pd.platform,
       sum(pd.cost_usd) AS usd, sum(pd.consumption) AS cons,
       count(DISTINCT CASE WHEN ${M.ACT} THEN pd.person_key END) AS au
     ${base} GROUP BY un, v, pd.platform`
  ).all(ctx.datasetId, ctx.from, ctx.to);
  const rowAu = db.prepare(
    `SELECT (p.person_key IS NULL) AS un, p.${col} AS v, count(DISTINCT CASE WHEN ${M.ACT} THEN pd.person_key END) AS au
     ${base} GROUP BY un, v`
  ).all(ctx.datasetId, ctx.from, ctx.to);
  const colAu = db.prepare(
    `SELECT pd.platform, count(DISTINCT CASE WHEN ${M.ACT} THEN pd.person_key END) AS au ${base} GROUP BY pd.platform`
  ).all(ctx.datasetId, ctx.from, ctx.to);
  const allAu = db.prepare(`SELECT count(DISTINCT CASE WHEN ${M.ACT} THEN pd.person_key END) AS au ${base}`).get(ctx.datasetId, ctx.from, ctx.to);

  const rows = new Map();
  function rowFor(key, label, sort) {
    if (!rows.has(key)) {
      const c = {};
      for (const id of ids) c[id] = { cons_usd: 0, seat_usd: 0, active_users: 0, consumption: 0 };
      rows.set(key, { key, label, sort, cells: c, au: 0 });
    }
    return rows.get(key);
  }
  rowFor('__unassigned__', 'Unassigned', 998);
  rowFor('__unmatched__', 'Unmatched usage', 999);
  for (const r of cells) {
    const key = rowKeyFor(map, r.un, r.v);
    const label = key === '__unmatched__' ? 'Unmatched usage' : key === '__unassigned__' ? 'Unassigned' : r.v;
    const sort = key === '__unmatched__' ? 999 : key === '__unassigned__' ? 998 : num(r.s);
    const row = rowFor(key, label, sort);
    const cell = row.cells[r.platform];
    cell.cons_usd += num(r.usd);
    cell.consumption += num(r.cons);
    cell.active_users += r.au;
  }
  for (const r of rowAu) {
    const key = rowKeyFor(map, r.un, r.v);
    if (rows.has(key)) rows.get(key).au += r.au;
  }

  // Seat spend lands on matched rows in proportion to active people per month; the rest sits on Unassigned.
  if (ctx.basis !== 'consumption') {
    const mFrom = M.monthOf(ctx.from);
    const mTo = M.monthOf(ctx.to);
    const shares = new Map();
    for (const r of db.prepare(
      `SELECT month, platform, ${col} AS v, sum(active_users) AS au FROM rollup_org_month
       WHERE dataset_id = ? AND matched = 1 AND month BETWEEN ? AND ? AND platform IN (${list}) GROUP BY month, platform, v`
    ).all(ctx.datasetId, mFrom, mTo)) {
      const k = `${r.platform}|${r.month}`;
      if (!shares.has(k)) shares.set(k, []);
      shares.get(k).push(r);
    }
    for (const id of ids) {
      for (let ym = mFrom; ym <= mTo; ym = M.addMonths(ym, 1)) {
        const s = ctx.from > `${ym}-01` ? ctx.from : `${ym}-01`;
        const e = ctx.to < M.monthEnd(ym) ? ctx.to : M.monthEnd(ym);
        const usd = seat.between(id, s, e);
        if (!usd) continue;
        const list2 = shares.get(`${id}|${ym}`) || [];
        const tot = list2.reduce((a, r) => a + num(r.au), 0);
        if (tot <= 0) { rowFor('__unassigned__', 'Unassigned', 998).cells[id].seat_usd += usd; continue; }
        for (const r of list2) {
          const key = rowKeyFor(map, false, r.v);
          const row = rowFor(key, key === '__unassigned__' ? 'Unassigned' : r.v, key === '__unassigned__' ? 998 : 0);
          row.cells[id].seat_usd += (usd * num(r.au)) / tot;
        }
      }
    }
  }

  const colTotals = {};
  for (const id of ids) colTotals[id] = { usd: 0, consumption: 0, au: 0 };
  for (const r of colAu) if (colTotals[r.platform]) colTotals[r.platform].au = r.au;
  let grand = 0;
  const outRows = [];
  for (const row of rows.values()) {
    const cellsOut = {};
    let total = 0;
    for (const id of ids) {
      const c = row.cells[id];
      const usd = M.pickBasis(ctx.basis, c.cons_usd, c.seat_usd);
      total += usd;
      colTotals[id].usd += usd;
      colTotals[id].consumption += c.consumption;
      cellsOut[id] = { usd: round2(usd), active_users: c.active_users, consumption: cons(id, c.consumption) };
    }
    grand += total;
    outRows.push({
      key: row.key, label: row.label, sort: row.sort, cells: cellsOut, total: { usd: round2(total), active_users: row.au },
    });
  }
  const unmatched = outRows.filter((r) => r.key === '__unmatched__');
  const rest = outRows.filter((r) => r.key !== '__unmatched__');
  const metric = (r) => (measure === 'users' ? r.total.active_users : r.total.usd);
  rest.sort((a, b) => a.sort - b.sort || metric(b) - metric(a) || String(a.label).localeCompare(String(b.label)));
  if (dim !== 'lob_cg') {
    // Sort values carry no meaning outside LOB-CG: number the rows in display order.
    let n = 1;
    for (const r of rest) if (r.key !== '__unassigned__') r.sort = n++;
  }
  const totCells = {};
  for (const id of ids) {
    totCells[id] = { usd: round2(colTotals[id].usd), active_users: colTotals[id].au, consumption: cons(id, colTotals[id].consumption) };
  }
  return {
    asOf: ctx.asOf, dim, measure, basis: ctx.basis, rows: rest.concat(unmatched),
    totals: { cells: totCells, total: { usd: round2(grand), active_users: allAu ? allAu.au : 0 } },
  };
}

function orgCell(query) {
  const { dim } = orgParams(query);
  const key = M.first((query || {}).key);
  const platform = M.first((query || {}).platform);
  if (!key) throw badRequest('key is required');
  if (!platform || !platformsMod.byId(platform)) throw badRequest('platform must be one platform id');
  const q2 = Object.assign({}, query, { platform, basis: 'consumption', measure: 'spend' });
  const ctx = M.resolve(q2);
  const col = DIMS[dim];
  const map = keyMap(ctx, col);
  let pred;
  const args = [ctx.datasetId, ctx.from, ctx.to, platform];
  if (key === '__unmatched__') pred = 'p.person_key IS NULL';
  else if (key === '__unassigned__') {
    pred = `(p.person_key IS NOT NULL AND (p.${col} IS NULL OR lower(trim(p.${col})) IN ('', 'unassigned', 'unknown')))`;
  } else {
    let value = null;
    for (const [v, k] of map) if (k === key) value = v;
    if (value === null) throw notFound('Row');
    pred = `p.${col} = ?`;
    args.push(value);
  }
  const base = `FROM rollup_person_day pd
     LEFT JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform = ? AND ${pred}`;
  const contributors = ctx.db.prepare(
    `SELECT pd.person_key, sum(pd.cost_usd) AS usd, sum(pd.consumption) AS cons, p.display_name ${base}
     GROUP BY pd.person_key ORDER BY usd DESC LIMIT 5`
  ).all(...args).map((r) => ({
    person_key: r.person_key, display_name: r.display_name || r.person_key, usd: round2(r.usd), consumption: cons(platform, r.cons),
  }));
  const cell = ctx.db.prepare(
    `SELECT sum(pd.cost_usd) AS usd, count(DISTINCT CASE WHEN ${M.ACT} THEN pd.person_key END) AS au ${base}`
  ).get(...args);
  const rowTot = ctx.db.prepare(
    `SELECT sum(pd.cost_usd) AS usd FROM rollup_person_day pd
     LEFT JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${inList(platformsMod.IDS)}) AND ${pred}`
  ).get(...[ctx.datasetId, ctx.from, ctx.to].concat(args.slice(4)));
  const colTot = ctx.db.prepare(
    'SELECT sum(cost_usd) AS usd FROM rollup_person_day WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform = ?'
  ).get(ctx.datasetId, ctx.from, ctx.to, platform);
  const cu = num(cell.usd);
  return {
    contributors,
    share_of_row: num(rowTot.usd) > 0 ? cu / num(rowTot.usd) : 0,
    share_of_column: num(colTot.usd) > 0 ? cu / num(colTot.usd) : 0,
    total: { usd: round2(cu), active_users: cell.au },
  };
}

// ---- users ---------------------------------------------------------------------------------

const USER_SORTS = ['usd', 'name', 'lob_cg', 'active_days'];

function escLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function users(query, opts = {}) {
  const qy = query || {};
  const sort = M.first(qy.sort) || 'usd';
  if (!USER_SORTS.includes(sort)) throw badRequest('sort must be usd, name, lob_cg or active_days');
  const dirQ = M.first(qy.dir);
  if (dirQ !== undefined && dirQ !== '' && dirQ !== 'asc' && dirQ !== 'desc') throw badRequest('dir must be asc or desc');
  const dir = dirQ || (sort === 'name' || sort === 'lob_cg' ? 'asc' : 'desc');
  const page = M.first(qy.page) === undefined ? 1 : Number(M.first(qy.page));
  let pageSize = M.first(qy.pageSize) === undefined ? 50 : Number(M.first(qy.pageSize));
  if (!Number.isInteger(page) || page < 1) throw badRequest('page must be a positive integer');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > (opts.maxPageSize || 200)) {
    throw badRequest(`pageSize must be between 1 and ${opts.maxPageSize || 200}`);
  }
  const ctx = M.resolve(qy);
  const ids = ctx.platforms;
  const args = [ctx.datasetId, ctx.from, ctx.to];
  let where = '';
  const q = M.first(qy.q) ? String(M.first(qy.q)).trim() : '';
  if (q) {
    const like = `%${escLike(q)}%`;
    where += " AND (pd.person_key LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')";
    args.push(like, like, like);
  }
  const lob = M.first(qy.lob_cg);
  if (lob) { where += ' AND p.lob_cg = ?'; args.push(String(lob)); }
  const region = M.first(qy.region);
  if (region) { where += ' AND p.region = ?'; args.push(String(region)); }
  const sblQ = M.first(qy.sbl);
  if (sblQ) { where += ' AND p.sbl = ?'; args.push(String(sblQ)); }
  const ptQ = M.first(qy.person_type);
  if (ptQ) { where += ' AND p.person_type = ?'; args.push(String(ptQ)); }
  const pivots = ids.map((id) => `sum(CASE WHEN pd.platform = '${id}' THEN pd.cost_usd ELSE 0 END) AS u_${id}`).join(', ');
  const all = ctx.db.prepare(
    `SELECT pd.person_key, sum(pd.cost_usd) AS usd, count(DISTINCT CASE WHEN ${M.ACT} THEN pd.date END) AS active_days,
       ${pivots}, p.display_name, p.lob_cg, p.region, p.sbl, p.person_type, (p.person_key IS NOT NULL) AS matched
     FROM rollup_person_day pd LEFT JOIN people p ON p.dataset_id = pd.dataset_id AND p.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${inList(ids)})${where}
     GROUP BY pd.person_key`
  ).all(...args);
  const shaped = all.map((r) => {
    const plat = {};
    for (const id of ids) plat[id] = round2(r[`u_${id}`]);
    return {
      person_key: r.person_key, display_name: r.display_name || r.person_key, lob_cg: r.lob_cg || 'Unmatched usage',
      region: r.region || 'Unknown', sbl: r.sbl || 'Unknown', person_type: r.person_type || 'Unknown', matched: r.matched ? 1 : 0,
      usd: round2(r.usd), platforms: plat, active_days: r.active_days,
    };
  });
  const sign = dir === 'asc' ? 1 : -1;
  const str = (a) => String(a).toLowerCase();
  shaped.sort((a, b) => {
    let d = 0;
    if (sort === 'name') d = str(a.display_name).localeCompare(str(b.display_name));
    else if (sort === 'lob_cg') d = str(a.lob_cg).localeCompare(str(b.lob_cg));
    else if (sort === 'active_days') d = a.active_days - b.active_days;
    else d = a.usd - b.usd;
    if (d !== 0) return d * sign;
    return b.usd - a.usd || (a.person_key < b.person_key ? -1 : 1);
  });
  const start = (page - 1) * pageSize;
  return { asOf: ctx.asOf, rows: shaped.slice(start, start + pageSize), total: shaped.length, page, pageSize };
}

function userDetail(rawKey, query) {
  const key = String(rawKey).replace(/\u00a0/g, ' ').trim().toLowerCase();
  const ctx = M.resolve(query);
  const { db } = ctx;
  const person = db.prepare('SELECT * FROM people WHERE dataset_id = ? AND person_key = ?').get(ctx.datasetId, key);
  const seen = db.prepare('SELECT 1 FROM rollup_person_day WHERE dataset_id = ? AND person_key = ? LIMIT 1').get(ctx.datasetId, key);
  if (!person && !seen) throw notFound('User');
  const per = db.prepare(
    `SELECT platform, sum(cost_usd) AS usd, sum(consumption) AS cons,
       count(DISTINCT CASE WHEN cost_usd > 0 OR tokens > 0 OR credits > 0 THEN date END) AS days
     FROM rollup_person_day WHERE dataset_id = ? AND person_key = ? AND date BETWEEN ? AND ? GROUP BY platform`
  ).all(ctx.datasetId, key, ctx.from, ctx.to);
  const order = platformsMod.IDS;
  per.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
  const daily = new Map(db.prepare(
    'SELECT date, sum(cost_usd) AS usd FROM rollup_person_day WHERE dataset_id = ? AND person_key = ? AND date BETWEEN ? AND ? GROUP BY date'
  ).all(ctx.datasetId, key, ctx.from, ctx.to).map((r) => [r.date, r.usd]));
  const trendRows = [];
  for (let d = ctx.from; d <= ctx.to; d = time.addDays(d, 1)) trendRows.push({ date: d, usd: round2(daily.get(d) || 0) });
  const modelsOut = db.prepare(
    `SELECT platform, model, sum(cost_usd) AS usd, sum(consumption) AS cons FROM usage
     WHERE dataset_id = ? AND person_key = ? AND date BETWEEN ? AND ? AND coalesce(model, '') <> ''
     GROUP BY platform, model ORDER BY usd DESC`
  ).all(ctx.datasetId, key, ctx.from, ctx.to).map((r) => ({
    platform: r.platform, model: r.model, usd: round2(r.usd), consumption: cons(r.platform, r.cons),
  }));
  const activity = db.prepare(
    `SELECT date, platform, model, sum(consumption) AS cons, sum(cost_usd) AS usd FROM usage
     WHERE dataset_id = ? AND person_key = ? GROUP BY date, platform, model ORDER BY date DESC, platform, model LIMIT 50`
  ).all(ctx.datasetId, key).map((r) => ({
    date: r.date, platform: r.platform, model: r.model ? r.model : null, consumption: cons(r.platform, r.cons), usd: round2(r.usd),
  }));
  return {
    asOf: ctx.asOf,
    person: {
      person_key: key, display_name: person ? person.display_name || key : key, email: person ? person.email || '' : '',
      user_id: person ? person.user_id || '' : '', lob_cg: person ? person.lob_cg : 'Unmatched usage',
      region: person ? person.region : 'Unknown', sbl: person ? person.sbl : 'Unknown',
      office_code: person ? person.office_code || '' : '', person_type: person ? person.person_type : 'Unknown',
      matched: person ? 1 : 0,
    },
    spend: { usd: round2(per.reduce((a, r) => a + num(r.usd), 0)) },
    platforms: per.map((r) => ({ id: r.platform, usd: round2(r.usd), consumption: cons(r.platform, r.cons), active_days: r.days })),
    trend: trendRows, models: modelsOut, activity,
  };
}

module.exports = {
  summary, trend, platformReport, organization, orgCell, models, modelDetail, users, userDetail, latestRun, runShape,
  checkShape, parseJson, buildBuckets,
};
