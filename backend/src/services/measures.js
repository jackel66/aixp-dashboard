'use strict';
// Shared measure logic for the report queries: request context, spend bases, seat spend,
// active users, windows and bucketing. Reports read rollup_* tables (CONTRACT section 8).
const { getDb } = require('../db');
const datasets = require('./datasets');
const settings = require('./settings');
const rollups = require('./rollups');
const platformsMod = require('../platforms');
const { badRequest, notFound, conflict, HttpError } = require('../errors');
const time = require('./time');

const BASES = ['consumption', 'seat', 'total'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

function parseDate(s, name) {
  const v = String(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${name} must be a date as YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest(`${name} is not a real date`);
  return v;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function parsePlatforms(q) {
  const raw = [].concat(q === undefined ? [] : q).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  if (!raw.length) return null;
  for (const id of raw) if (!platformsMod.byId(id)) throw badRequest(`Unknown platform "${id}"`);
  return Array.from(new Set(raw));
}

function monthOf(date) { return date.slice(0, 7); }
function monthStart(date) { return `${date.slice(0, 7)}-01`; }
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthEnd(ym) { return `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`; }
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function fmtShort(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MON[m - 1]}`;
}
function dateLong(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
}
function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// Request context: dataset, asOf, range, platforms, basis. Throws 400/404/409 on bad input.
function resolve(query) {
  const db = getDb();
  rollups.ensureIndexes(db);
  const q = query || {};
  let ds;
  const dsParam = first(q.dataset);
  if (dsParam !== undefined && dsParam !== '') {
    const id = Number(dsParam);
    if (!Number.isInteger(id) || id < 1) throw badRequest('dataset must be a dataset id');
    ds = datasets.get(id);
    if (!ds) throw notFound('Dataset');
  } else {
    ds = datasets.active();
    if (!ds) throw new HttpError(404, 'No active dataset yet');
  }
  const mx = db.prepare('SELECT max(date) AS d FROM rollup_platform_day WHERE dataset_id = ?').get(ds.id);
  if (!mx || !mx.d) throw conflict('Dataset has no rollups; promote it first');
  const asOf = mx.d;
  const fromQ = first(q.from);
  const toQ = first(q.to);
  const hasFrom = fromQ !== undefined && fromQ !== '';
  const hasTo = toQ !== undefined && toQ !== '';
  let from = hasFrom ? parseDate(fromQ, 'from') : null;
  let to = hasTo ? parseDate(toQ, 'to') : null;
  if (!to) to = hasFrom && from > asOf ? from : asOf;
  if (!from) from = time.addDays(to, -89);
  if (from > to) throw badRequest('from must not be after to');
  const platforms = parsePlatforms(q.platform);
  const basisQ = first(q.basis);
  let basis = settings.get('spend.default_basis', 'consumption');
  if (basisQ !== undefined && basisQ !== '') {
    if (!BASES.includes(basisQ)) throw badRequest('basis must be consumption, seat or total');
    basis = basisQ;
  }
  if (!BASES.includes(basis)) basis = 'consumption';
  return {
    db, ds, datasetId: ds.id, asOf, from, to, explicitRange: hasFrom || hasTo, explicitFrom: hasFrom, explicitTo: hasTo,
    platforms: platforms || platformsMod.IDS.slice(), allPlatforms: !platforms, basis,
    dayCount: time.diffDays(from, to) + 1,
  };
}

function inList(ids) {
  return ids.map((id) => `'${String(id).replace(/[^a-z0-9_]/g, '')}'`).join(',');
}

// per platform min/max date over the whole dataset
function platformDates(ctx) {
  const out = {};
  for (const r of ctx.db.prepare(
    'SELECT platform, min(date) AS min_date, max(date) AS max_date FROM rollup_platform_day WHERE dataset_id = ? GROUP BY platform'
  ).all(ctx.datasetId)) out[r.platform] = { min: r.min_date, max: r.max_date };
  return out;
}

// ---- seat spend ----------------------------------------------------------------------------

function loadSeat(ctx) {
  const mode = settings.get('spend.seat_basis', 'licensed') === 'active' ? 'active' : 'licensed';
  const byKey = new Map();
  for (const r of ctx.db.prepare('SELECT platform, month, rate_usd, licensed_seats FROM seat_rate WHERE dataset_id = ?').all(ctx.datasetId)) {
    byKey.set(`${r.platform}|${r.month}`, { rate: num(r.rate_usd), seats: num(r.licensed_seats) });
  }
  const activeSeats = new Map();
  if (mode === 'active') {
    for (const r of ctx.db.prepare(
      `SELECT platform, month, count(*) AS n FROM rollup_person_month
       WHERE dataset_id = ? AND (cost_usd > 0 OR tokens > 0 OR credits > 0) GROUP BY platform, month`
    ).all(ctx.datasetId)) activeSeats.set(`${r.platform}|${r.month}`, r.n);
  }
  function monthly(platform, ym) {
    const k = `${platform}|${ym}`;
    const row = byKey.get(k);
    if (!row) return 0;
    const seats = mode === 'active' ? num(activeSeats.get(k)) : row.seats;
    return row.rate * seats;
  }
  // Seat spend for platform over [a, b]: monthly cost prorated by the days of each month inside the window.
  function between(platform, a, b) {
    if (a > b) return 0;
    let usd = 0;
    for (let ym = monthOf(a); ym <= monthOf(b); ym = addMonths(ym, 1)) {
      const s = a > `${ym}-01` ? a : `${ym}-01`;
      const e = b < monthEnd(ym) ? b : monthEnd(ym);
      const days = time.diffDays(s, e) + 1;
      usd += (monthly(platform, ym) * days) / daysInMonth(ym);
    }
    return usd;
  }
  return { mode, estimate: mode === 'active', monthly, between };
}

const spendTriple = (cons, seat) => ({
  consumption: { usd: round2(cons) },
  seat: { usd: round2(seat) },
  total: { usd: round2(num(cons) + num(seat)) },
});

function pickBasis(basis, cons, seat) {
  if (basis === 'seat') return num(seat);
  if (basis === 'total') return num(cons) + num(seat);
  return num(cons);
}

// consumption spend per platform over a window (rollup_platform_day)
function consumptionByPlatform(ctx, from, to, platforms) {
  const out = {};
  for (const id of platforms) out[id] = { usd: 0, rows: 0, consumption: 0, tokens: 0, credits: 0, requests: 0 };
  for (const r of ctx.db.prepare(
    `SELECT platform, sum(cost_usd) AS usd, sum(rows) AS rows, sum(consumption) AS cons, sum(tokens) AS tokens,
       sum(credits) AS credits, sum(requests) AS req
     FROM rollup_platform_day WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${inList(platforms)})
     GROUP BY platform`
  ).all(ctx.datasetId, from, to)) {
    out[r.platform] = {
      usd: num(r.usd), rows: num(r.rows), consumption: num(r.cons), tokens: num(r.tokens), credits: num(r.credits), requests: num(r.req),
    };
  }
  return out;
}

const ACT = '(pd.cost_usd > 0 OR pd.tokens > 0 OR pd.credits > 0)';

// distinct active people per platform and overall over a window
function activeUsers(ctx, from, to, platforms) {
  const byPlatform = {};
  for (const id of platforms) byPlatform[id] = 0;
  for (const r of ctx.db.prepare(
    `SELECT pd.platform, count(DISTINCT pd.person_key) AS n FROM rollup_person_day pd
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${inList(platforms)}) AND ${ACT}
     GROUP BY pd.platform`
  ).all(ctx.datasetId, from, to)) byPlatform[r.platform] = r.n;
  const t = ctx.db.prepare(
    `SELECT count(DISTINCT pd.person_key) AS n FROM rollup_person_day pd
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${inList(platforms)}) AND ${ACT}`
  ).get(ctx.datasetId, from, to);
  return { byPlatform, total: t ? t.n : 0 };
}

function previousWindow(from, to) {
  const days = time.diffDays(from, to) + 1;
  return { from: time.addDays(from, -days), to: time.addDays(from, -1), days };
}

// ---- bucketing -----------------------------------------------------------------------------

const GRAINS = ['day', 'week', 'month'];
const BUCKET_SQL = {
  day: (c) => c,
  week: (c) => `date(${c}, '-' || ((cast(strftime('%w', ${c}) as integer) + 6) % 7) || ' days')`,
  month: (c) => `(substr(${c}, 1, 7) || '-01')`,
};

function bucketStart(grain, date) {
  if (grain === 'day') return date;
  if (grain === 'week') return time.mondayOf(date);
  return monthStart(date);
}
function nextBucket(grain, start) {
  if (grain === 'day') return time.addDays(start, 1);
  if (grain === 'week') return time.addDays(start, 7);
  return `${addMonths(monthOf(start), 1)}-01`;
}
function bucketEnd(grain, start) {
  return time.addDays(nextBucket(grain, start), -1);
}
function bucketLabel(grain, start) {
  if (grain === 'month') {
    const [y, m] = start.split('-').map(Number);
    return `${MON[m - 1]} ${y}`;
  }
  return fmtShort(start);
}
function bucketList(grain, from, to) {
  const out = [];
  for (let s = bucketStart(grain, from); s <= to; s = nextBucket(grain, s)) out.push(s);
  return out;
}

module.exports = {
  BASES, GRAINS, BUCKET_SQL, MON, round2, num, parseDate, parsePlatforms, resolve, inList, platformDates, loadSeat,
  spendTriple, pickBasis, consumptionByPlatform, activeUsers, previousWindow, bucketStart, nextBucket, bucketEnd,
  bucketLabel, bucketList, monthOf, monthStart, monthEnd, addMonths, daysInMonth, fmtShort, dateLong, monthName,
  first, ACT,
};
