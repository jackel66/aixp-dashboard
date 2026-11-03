'use strict';
// Report runner (CONTRACT section 12). run(id, query) -> the response shape. One function per
// report. Reads rollup_* tables; the only reads of `usage` are models_cost (distinct users per model,
// through reports.models) and models_by_group (no rollup carries person x model).
// Conventions: pct values are percent numbers (11.3 = 11.3 percent), money values are USD numbers, units values are {value, unit}.
// Spend that follows the basis param uses the same seat allocation as /api/organization.
const M = require('./measures');
const catalog = require('./reportCatalog');
const reports = require('./reports');
const settings = require('./settings');
const time = require('./time');
const platformsMod = require('../platforms');
const { badRequest, notFound } = require('../errors');

const { round2, num, inList } = M;

const DIMS = ['lob_cg', 'region', 'sbl', 'person_type'];
const UNASSIGNED = new Set(['', 'unassigned', 'unknown']);
const unitOf = (id) => (platformsMod.byId(id) || {}).unit || 'units';
const nameOf = (id) => (platformsMod.byId(id) || {}).name || id;
const cons = (id, v) => ({ value: round2(v), unit: unitOf(id) });
const pad2 = (n) => String(n).padStart(2, '0');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
const monthLabel = (ym) => M.bucketLabel('month', `${ym}-01`);
const ratio = (a, b) => (num(b) > 0 ? num(a) / num(b) : null);
const pctOf = (a, b) => (num(b) > 0 ? Math.round((num(a) / num(b)) * 1000) / 10 : null);
const idsText = (ids) => platformsMod.IDS.filter((i) => ids.includes(i)).map(nameOf).join(', ');

function delta(now, prev) {
  if (prev === null || prev === undefined) return { now: round2(now), prev: null, delta: null, pct: null };
  return { now: round2(now), prev: round2(prev), delta: round2(num(now) - num(prev)), pct: pctOf(num(now) - num(prev), prev) };
}

function chart(type, labels, series) {
  return { type, labels, series };
}

function peopleMap(ctx) {
  const map = new Map();
  for (const r of ctx.db.prepare('SELECT person_key, display_name, lob_cg, region FROM people WHERE dataset_id = ?').all(ctx.datasetId)) {
    map.set(r.person_key, r);
  }
  return map;
}

function who(map, key) {
  const p = map.get(key);
  return {
    user: (p && p.display_name) || key || '(blank key)',
    lob_cg: p ? p.lob_cg || 'Unassigned' : 'Unmatched usage',
    region: p ? p.region || 'Unknown' : 'Unknown',
  };
}

function pivots(ids) {
  return ids.map((id) => `sum(CASE WHEN pd.platform = '${id}' THEN pd.cost_usd ELSE 0 END) AS u_${id}`).join(', ');
}
function perPlatform(row, ids) {
  const o = {};
  for (const id of platformsMod.IDS) o[`usd_${id}`] = ids.includes(id) ? round2(row[`u_${id}`]) : 0;
  return o;
}

// spend per platform over a window: {cons: {id}, seat: {id}}
function spendWindow(ctx, seat, from, to, ids) {
  const c = M.consumptionByPlatform(ctx, from, to, ids);
  const out = { cons: {}, seat: {} };
  for (const id of ids) {
    out.cons[id] = c[id].usd;
    out.seat[id] = seat.between(id, from, to);
  }
  return out;
}
const basisTotal = (basis, w, ids) => ids.reduce((a, id) => a + M.pickBasis(basis, w.cons[id], w.seat[id]), 0);

function orgCall(ctx, dim, basis, from, to) {
  return reports.organization({
    dataset: ctx.datasetId, from, to, dim, basis, platform: ctx.allPlatforms ? undefined : ctx.platforms,
  });
}

function seatNote(seat) {
  return seat.estimate ? ['Seat spend is an estimate: seats are counted as active people, not licensed seats.'] : [];
}

// month windows clipped to the range, with the same days of the previous month for the change column
function monthWindows(ctx) {
  const out = [];
  for (let ym = M.monthOf(ctx.from); ym <= M.monthOf(ctx.to); ym = M.addMonths(ym, 1)) {
    const s = ctx.from > `${ym}-01` ? ctx.from : `${ym}-01`;
    const e = ctx.to < M.monthEnd(ym) ? ctx.to : M.monthEnd(ym);
    const pym = M.addMonths(ym, -1);
    const pdays = M.daysInMonth(pym);
    out.push({
      ym, s, e,
      ps: `${pym}-${pad2(Math.min(Number(s.slice(8)), pdays))}`,
      pe: `${pym}-${pad2(Math.min(Number(e.slice(8)), pdays))}`,
    });
  }
  return out;
}

const PARTIAL_NOTE = 'Months at the edges of the range cover only the days inside it. The change column compares the same days of the previous month.';

// ---- users ---------------------------------------------------------------------------------

function usersTop(ctx, p) {
  const ids = ctx.platforms;
  const base = 'FROM rollup_person_day pd WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN';
  const all = ctx.db.prepare(
    `SELECT pd.person_key, sum(pd.cost_usd) AS usd, count(DISTINCT CASE WHEN ${M.ACT} THEN pd.date END) AS ad, ${pivots(ids)}
     ${base} (${inList(ids)}) GROUP BY pd.person_key HAVING usd > 0 ORDER BY usd DESC, pd.person_key LIMIT ?`
  ).all(ctx.datasetId, ctx.from, ctx.to, p.limit);
  const tot = ctx.db.prepare(
    `SELECT sum(pd.cost_usd) AS usd, count(DISTINCT CASE WHEN ${M.ACT} THEN pd.person_key END) AS n ${base} (${inList(ids)})`
  ).get(ctx.datasetId, ctx.from, ctx.to);
  const people = peopleMap(ctx);
  const rows = all.map((r, i) => {
    const w = who(people, r.person_key);
    return {
      rank: i + 1, user: w.user, lob_cg: w.lob_cg, region: w.region, usd: round2(r.usd), ...perPlatform(r, ids),
      active_days: r.ad, share: pctOf(r.usd, tot.usd) || 0, person_key: r.person_key,
    };
  });
  const top = rows.slice(0, 10);
  return {
    rows, totals: { user: `Total (${tot.n} users)`, usd: round2(tot.usd), share: 100 },
    chart: chart('bar', top.map((r) => r.user), [{ label: 'Spend (USD)', data: top.map((r) => r.usd), platform: null }]),
    notes: ['Spend is consumption spend. Seat spend is not attributed to individual people.'],
  };
}

function usersNew(ctx, p) {
  const ids = ctx.platforms;
  const list = inList(ids);
  const rowsDb = ctx.db.prepare(
    `WITH cand AS (SELECT DISTINCT pd.person_key FROM rollup_person_day pd
        WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${list}) AND ${M.ACT}),
     newp AS (SELECT c.person_key FROM cand c WHERE NOT EXISTS (
        SELECT 1 FROM rollup_person_day b WHERE b.dataset_id = ? AND b.person_key = c.person_key AND b.date < ?
          AND b.platform IN (${list}) AND (b.cost_usd > 0 OR b.tokens > 0 OR b.credits > 0)))
     SELECT pd.person_key, pd.date, pd.platform, pd.cost_usd FROM rollup_person_day pd JOIN newp n ON n.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${list}) AND ${M.ACT}`
  ).all(ctx.datasetId, ctx.from, ctx.to, ctx.datasetId, ctx.from, ctx.datasetId, ctx.from, ctx.to);
  const byUser = new Map();
  for (const r of rowsDb) {
    if (!byUser.has(r.person_key)) byUser.set(r.person_key, []);
    byUser.get(r.person_key).push(r);
  }
  const people = peopleMap(ctx);
  const all = [];
  for (const [key, rs] of byUser) {
    const first = rs.reduce((a, r) => (r.date < a ? r.date : a), rs[0].date);
    const onFirst = {};
    const used = new Set();
    let usd = 0;
    for (const r of rs) {
      used.add(r.platform);
      usd += num(r.cost_usd);
      if (r.date === first) onFirst[r.platform] = (onFirst[r.platform] || 0) + num(r.cost_usd);
    }
    const fp = Object.keys(onFirst).sort((a, b) => onFirst[b] - onFirst[a] || platformsMod.IDS.indexOf(a) - platformsMod.IDS.indexOf(b))[0];
    const w = who(people, key);
    all.push({
      user: w.user, lob_cg: w.lob_cg, first_seen: first, first_platform: fp, usd_since: round2(usd),
      platforms: used.size, person_key: key,
    });
  }
  all.sort((a, b) => (a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : b.usd_since - a.usd_since));
  const buckets = M.bucketList('week', ctx.from, ctx.to);
  const count = new Map(buckets.map((b) => [b, 0]));
  for (const r of all) {
    const b = M.bucketStart('week', r.first_seen);
    count.set(b, (count.get(b) || 0) + 1);
  }
  const notes = [];
  const dsMin = ctx.db.prepare('SELECT min(date) AS d FROM rollup_platform_day WHERE dataset_id = ?').get(ctx.datasetId).d;
  if (dsMin && ctx.from <= dsMin) notes.push(`The dataset starts on ${dsMin}; people already active on that day count as new when the range includes it.`);
  return {
    rows: all.slice(0, p.limit), totals: { user: `Total (${all.length} users)`, usd_since: round2(all.reduce((a, r) => a + r.usd_since, 0)) },
    chart: chart('line', buckets.map((b) => M.bucketLabel('week', b)), [{ label: 'New users', data: buckets.map((b) => count.get(b) || 0), platform: null }]),
    notes,
  };
}

function usersInactive(ctx, p) {
  const ids = ctx.platforms;
  const list = inList(ids);
  const wFrom = time.addDays(ctx.from, -90);
  const wTo = time.addDays(ctx.from, -1);
  const rowsDb = ctx.db.prepare(
    `WITH prior AS (SELECT pd.person_key, max(CASE WHEN ${M.ACT} THEN pd.date END) AS last_seen, sum(pd.cost_usd) AS usd
        FROM rollup_person_day pd WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${list}) AND ${M.ACT}
        GROUP BY pd.person_key)
     SELECT pr.person_key, pr.last_seen, pr.usd FROM prior pr WHERE NOT EXISTS (
        SELECT 1 FROM rollup_person_day b WHERE b.dataset_id = ? AND b.person_key = pr.person_key AND b.date BETWEEN ? AND ?
          AND b.platform IN (${list}) AND (b.cost_usd > 0 OR b.tokens > 0 OR b.credits > 0))
     ORDER BY pr.usd DESC, pr.person_key`
  ).all(ctx.datasetId, wFrom, wTo, ctx.datasetId, ctx.from, ctx.to);
  const people = peopleMap(ctx);
  const all = rowsDb.map((r) => {
    const w = who(people, r.person_key);
    return {
      user: w.user, lob_cg: w.lob_cg, last_seen: r.last_seen, days_silent: time.diffDays(r.last_seen, ctx.to), usd_before: round2(r.usd),
      person_key: r.person_key,
    };
  });
  return {
    rows: all.slice(0, p.limit), totals: { user: `Total (${all.length} users)`, usd_before: round2(all.reduce((a, r) => a + r.usd_before, 0)) }, chart: null,
    notes: [`Compares ${M.dateLong(wFrom)} to ${M.dateLong(wTo)} with the range.`],
  };
}

function usersMulti(ctx, p) {
  const ids = ctx.platforms;
  const flags = ids.map((id) => `max(CASE WHEN pd.platform = '${id}' AND ${M.ACT} THEN 1 ELSE 0 END) AS f_${id}`).join(', ');
  const rowsDb = ctx.db.prepare(
    `SELECT pd.person_key, sum(pd.cost_usd) AS usd, ${pivots(ids)}, ${flags}
     FROM rollup_person_day pd WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${inList(ids)})
     GROUP BY pd.person_key`
  ).all(ctx.datasetId, ctx.from, ctx.to);
  const people = peopleMap(ctx);
  const all = [];
  const dist = new Map();
  for (const r of rowsDb) {
    const n = ids.reduce((a, id) => a + (r[`f_${id}`] ? 1 : 0), 0);
    if (n < 2) continue;
    dist.set(n, (dist.get(n) || 0) + 1);
    const w = who(people, r.person_key);
    all.push({ user: w.user, lob_cg: w.lob_cg, platform_count: n, ...perPlatform(r, ids), usd: round2(r.usd), person_key: r.person_key });
  }
  all.sort((a, b) => b.platform_count - a.platform_count || b.usd - a.usd || (a.person_key < b.person_key ? -1 : 1));
  const counts = Array.from(dist.keys()).sort((a, b) => a - b);
  return {
    rows: all.slice(0, p.limit), totals: { user: `Total (${all.length} users)`, usd: round2(all.reduce((a, r) => a + r.usd, 0)) },
    chart: chart('bar', counts.map((n) => `${n} platforms`), [{ label: 'Users', data: counts.map((n) => dist.get(n)), platform: null }]),
    notes: [],
  };
}

function groupRows(org) {
  return org.rows.filter((r) => r.total.usd !== 0 || r.total.active_users !== 0);
}

function usersByGroup(ctx, p) {
  const org = orgCall(ctx, p.dim, ctx.basis, ctx.from, ctx.to);
  const grand = org.totals.total.usd;
  const all = groupRows(org).map((r) => ({
    group: r.label, users: r.total.active_users, usd: r.total.usd, usd_per_user: round2(ratio(r.total.usd, r.total.active_users) || 0),
    share: pctOf(r.total.usd, grand) || 0, key: r.key,
  })).sort((a, b) => b.usd - a.usd);
  const rows = all.slice(0, p.limit);
  const top = rows.slice(0, 12);
  return {
    rows, totals: { group: 'Total', users: org.totals.total.active_users, usd: round2(grand), usd_per_user: round2(ratio(grand, org.totals.total.active_users) || 0), share: 100 }, chart: chart('bar', top.map((r) => r.group), [{ label: 'Spend (USD)', data: top.map((r) => r.usd), platform: null }]),
    notes: [`Spend follows the ${ctx.basis} basis.`, ...seatNote(M.loadSeat(ctx))],
  };
}

function usersUnmatched(ctx, p) {
  const ids = ctx.platforms;
  const rowsDb = ctx.db.prepare(
    `SELECT pd.person_key, group_concat(DISTINCT pd.platform) AS pl, sum(pd.rows) AS n, sum(pd.cost_usd) AS usd
     FROM rollup_person_day pd LEFT JOIN people pe ON pe.dataset_id = pd.dataset_id AND pe.person_key = pd.person_key
     WHERE pd.dataset_id = ? AND pd.date BETWEEN ? AND ? AND pd.platform IN (${inList(ids)}) AND pe.person_key IS NULL
     GROUP BY pd.person_key ORDER BY usd DESC, pd.person_key`
  ).all(ctx.datasetId, ctx.from, ctx.to);
  const slice = rowsDb.slice(0, p.limit);
  const seen = new Map();
  if (slice.length) {
    for (const r of ctx.db.prepare(
      `SELECT person_key, min(date) AS f, max(date) AS l FROM rollup_person_day WHERE dataset_id = ? AND person_key IN (${slice.map(() => '?').join(',')})
       GROUP BY person_key`
    ).all(ctx.datasetId, ...slice.map((r) => r.person_key))) seen.set(r.person_key, r);
  }
  const rows = slice.map((r) => ({
    person_key: r.person_key || '(blank key)', platforms: String(r.pl || '').split(',').filter(Boolean).length, rows: num(r.n), usd: round2(r.usd),
    first_seen: seen.has(r.person_key) ? seen.get(r.person_key).f : null, last_seen: seen.has(r.person_key) ? seen.get(r.person_key).l : null,
  }));
  return {
    rows, totals: { person_key: `Total (${rowsDb.length} keys)`, rows: rowsDb.reduce((a, r) => a + num(r.n), 0), usd: round2(rowsDb.reduce((a, r) => a + num(r.usd), 0)) },
    chart: null, notes: ['First seen and last seen cover the whole dataset, not only the range.'],
  };
}

// ---- platforms -----------------------------------------------------------------------------

function seatRates(ctx) {
  const m = new Map();
  for (const r of ctx.db.prepare('SELECT platform, month, licensed_seats FROM seat_rate WHERE dataset_id = ?').all(ctx.datasetId)) {
    m.set(`${r.platform}|${r.month}`, num(r.licensed_seats));
  }
  return m;
}
function activePeopleByMonth(ctx, ids, fromYm, toYm) {
  const m = new Map();
  for (const r of ctx.db.prepare(
    `SELECT platform, month, count(*) AS n FROM rollup_person_month
     WHERE dataset_id = ? AND month BETWEEN ? AND ? AND platform IN (${inList(ids)}) AND (cost_usd > 0 OR tokens > 0 OR credits > 0)
     GROUP BY platform, month`
  ).all(ctx.datasetId, fromYm, toYm)) m.set(`${r.platform}|${r.month}`, r.n);
  return m;
}

function platformsSummary(ctx) {
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const dates = M.platformDates(ctx);
  const au = M.activeUsers(ctx, ctx.from, ctx.to, ids);
  const w = spendWindow(ctx, seat, ctx.from, ctx.to, ids);
  const cs = M.consumptionByPlatform(ctx, ctx.from, ctx.to, ids);
  const rates = seatRates(ctx);
  const ym = M.monthOf(ctx.to);
  const act = activePeopleByMonth(ctx, ids, ym, ym);
  const rows = ids.map((id) => {
    const d = dates[id];
    const total = w.cons[id] + w.seat[id];
    const seats = rates.has(`${id}|${ym}`) ? rates.get(`${id}|${ym}`) : null;
    return {
      platform: id, as_of: d ? d.max : null, lag_days: d ? time.diffDays(d.max, ctx.asOf) : null,
      consumption_usd: round2(w.cons[id]), seat_usd: round2(w.seat[id]), total_usd: round2(total), consumption: cons(id, cs[id].consumption),
      active_users: au.byPlatform[id], usd_per_active_user: round2(ratio(total, au.byPlatform[id]) || 0), licensed_seats: seats,
      seat_utilisation_pct: seats ? pctOf(act.get(`${id}|${ym}`) || 0, seats) : null,
    };
  });
  return {
    rows,
    totals: null,
    chart: chart('bar', rows.map((r) => nameOf(r.platform)), [{
      label: `Spend (USD, ${ctx.basis})`, data: ids.map((id) => round2(M.pickBasis(ctx.basis, w.cons[id], w.seat[id]))), platform: null,
    }]),
    notes: [`Seat utilisation is active people in ${monthLabel(ym)} over the licensed seats of that month.`,
      'Consumption units differ by platform and are never added together.', ...seatNote(seat)],
  };
}

function platformsMonthlyTotals(rows) {
  const t = { month: 'Total' };
  for (const id of platformsMod.IDS) t[`usd_${id}`] = round2(rows.reduce((a, r) => a + r[`usd_${id}`], 0));
  t.total = round2(rows.reduce((a, r) => a + r.total, 0));
  return t;
}

function platformsMonthly(ctx) {
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const wins = monthWindows(ctx);
  const rows = [];
  for (const w of wins) {
    const cur = spendWindow(ctx, seat, w.s, w.e, ids);
    const prev = spendWindow(ctx, seat, w.ps, w.pe, ids);
    const o = { month: monthLabel(w.ym), month_key: w.ym };
    let total = 0;
    for (const id of platformsMod.IDS) {
      const v = ids.includes(id) ? round2(M.pickBasis(ctx.basis, cur.cons[id], cur.seat[id])) : 0;
      o[`usd_${id}`] = v;
      total += v;
    }
    o.total = round2(total);
    o.delta = delta(total, basisTotal(ctx.basis, prev, ids));
    rows.push(o);
  }
  return {
    rows, totals: platformsMonthlyTotals(rows),
    chart: chart('stacked', rows.map((r) => r.month), ids.map((id) => ({ label: nameOf(id), data: rows.map((r) => r[`usd_${id}`]), platform: id }))),
    notes: [PARTIAL_NOTE, `Spend follows the ${ctx.basis} basis.`, ...seatNote(seat)],
  };
}

function platformsFreshness(ctx) {
  const ids = ctx.platforms;
  const dates = M.platformDates(ctx);
  const stale = num(settings.get('verify.stale_days', 5));
  const rowCounts = {};
  for (const r of ctx.db.prepare('SELECT platform, sum(rows) AS n FROM rollup_platform_day WHERE dataset_id = ? GROUP BY platform').all(ctx.datasetId)) {
    rowCounts[r.platform] = num(r.n);
  }
  const checks = {};
  const run = reports.latestRun(ctx.db, ctx.datasetId);
  let unscoped = 0;
  if (run) {
    for (const r of ctx.db.prepare(
      "SELECT platform, severity, count(*) AS n FROM verification_results WHERE run_id = ? AND status = 'fail' GROUP BY platform, severity"
    ).all(run.id)) {
      if (!r.platform) { unscoped += r.n; continue; }
      if (!checks[r.platform]) checks[r.platform] = { fail: 0, warn: 0 };
      if (r.severity === 'fail') checks[r.platform].fail += r.n;
      else if (r.severity === 'warn') checks[r.platform].warn += r.n;
    }
  }
  const rows = ids.map((id) => {
    const d = dates[id];
    const lag = d ? time.diffDays(d.max, ctx.asOf) : null;
    const c = checks[id] || { fail: 0, warn: 0 };
    return {
      platform: id, as_of: d ? d.max : null, lag_days: lag, stale: lag === null || lag > stale ? 'Stale' : 'Current',
      coverage_from: d ? d.min : null, coverage_to: d ? d.max : null, rows: rowCounts[id] || 0, checks_failed: c.fail, checks_warn: c.warn,
    };
  });
  const notes = [`A platform is stale when it lags the dataset by more than ${stale} days.`];
  if (unscoped) notes.push(`${unscoped} failing check(s) apply to the whole dataset and are not counted per platform.`);
  if (!run) notes.push('No verification run exists for this dataset yet.');
  return { rows, totals: null, chart: null, notes };
}

function platformsSeatUtilisation(ctx) {
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const fromYm = M.monthOf(ctx.from);
  const toYm = M.monthOf(ctx.to);
  const rates = seatRates(ctx);
  const act = activePeopleByMonth(ctx, ids, fromYm, toYm);
  const cmap = new Map();
  for (const r of ctx.db.prepare(
    `SELECT platform, substr(date, 1, 7) AS m, sum(cost_usd) AS usd FROM rollup_platform_day
     WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${inList(ids)}) GROUP BY platform, m`
  ).all(ctx.datasetId, `${fromYm}-01`, M.monthEnd(toYm))) cmap.set(`${r.platform}|${r.m}`, num(r.usd));
  const months = [];
  for (let ym = fromYm; ym <= toYm; ym = M.addMonths(ym, 1)) months.push(ym);
  const rows = [];
  for (const id of ids) {
    for (const ym of months) {
      const seats = rates.has(`${id}|${ym}`) ? rates.get(`${id}|${ym}`) : null;
      const active = act.get(`${id}|${ym}`) || 0;
      if (seats === null && !active) continue;
      const seatUsd = seat.monthly(id, ym);
      const consUsd = cmap.get(`${id}|${ym}`) || 0;
      rows.push({
        platform: id, month: monthLabel(ym), licensed_seats: seats, active_people: active, utilisation_pct: seats ? pctOf(active, seats) : null,
        seat_usd: round2(seatUsd), consumption_usd: round2(consUsd), usd_per_active: round2(ratio(seatUsd + consUsd, active) || 0), month_key: ym,
      });
    }
  }
  return {
    rows, totals: null,
    chart: chart('line', months.map(monthLabel), ids.map((id) => ({
      label: nameOf(id), platform: id,
      data: months.map((ym) => { const r = rows.find((x) => x.platform === id && x.month_key === ym); return r && r.utilisation_pct !== null ? r.utilisation_pct : null; }),
    }))),
    notes: ['Utilisation is a percent of licensed seats. Months are whole calendar months; the latest month counts people active so far.', ...seatNote(seat)],
  };
}

// ---- models --------------------------------------------------------------------------------

function modelsCost(ctx, p, q) {
  const data = reports.models(q);
    const rows = data.rows.slice(0, p.limit).map((r) => ({
    platform: r.platform, model: r.model, usd: r.usd, consumption: r.consumption, requests: r.requests, users: r.users,
    cost_per_million: r.cost_per_unit === null ? null : round2(r.cost_per_unit * 1e6), share: Math.round(num(r.share) * 1000) / 10,
  }));
  const top = rows.slice(0, 10);
  return {
    rows, totals: null,
    chart: chart('bar', top.map((r) => `${r.model} (${nameOf(r.platform)})`), [{ label: 'Spend (USD)', data: top.map((r) => r.usd), platform: null }]),
    notes: ['Only the token platforms report models. Users counts distinct people active on the model in the range.'],
  };
}

// top models by spend over the range from rollup_model_day: [{platform, model, usd}]
function topModels(ctx, n) {
  const tids = ctx.platforms.filter((i) => platformsMod.byId(i).models);
  if (!tids.length) return [];
  return ctx.db.prepare(
    `SELECT platform, model, sum(cost_usd) AS usd FROM rollup_model_day
     WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${inList(tids)}) AND model <> ''
     GROUP BY platform, model ORDER BY usd DESC, model LIMIT ?`
  ).all(ctx.datasetId, ctx.from, ctx.to, n);
}
function modelColumns(models, prefix) {
  const dup = new Set();
  const seen = new Set();
  for (const m of models) { if (seen.has(m.model)) dup.add(m.model); seen.add(m.model); }
  return models.map((m, i) => ({
    key: `${prefix}_${i}`, label: dup.has(m.model) ? `${m.model} (${nameOf(m.platform)})` : m.model, platform: m.platform, model: m.model,
  }));
}

function modelsAdoption(ctx) {
  const models = topModels(ctx, 8);
  const mcols = modelColumns(models, 'u');
  const buckets = M.bucketList('week', ctx.from, ctx.to);
  const grid = new Map();
  if (models.length) {
    for (const r of ctx.db.prepare(
      `SELECT ${M.BUCKET_SQL.week('date')} AS b, platform, model, avg(active_users) AS au FROM rollup_model_day
       WHERE dataset_id = ? AND date BETWEEN ? AND ? AND platform IN (${inList(Array.from(new Set(models.map((m) => m.platform))))}) AND model <> ''
       GROUP BY b, platform, model`
    ).all(ctx.datasetId, ctx.from, ctx.to)) grid.set(`${r.b}|${r.platform}|${r.model}`, r.au);
  }
  const rows = buckets.map((b) => {
    const o = { week: M.bucketLabel('week', b) };
    mcols.forEach((c) => { o[c.key] = Math.round(num(grid.get(`${b}|${c.platform}|${c.model}`)) * 10) / 10; });
    return o;
  });
  return {
    columns: [{ key: 'week', label: 'Week', type: 'text' }, ...mcols.map((c) => ({ key: c.key, label: c.label, type: 'number' }))],
    rows, totals: null,
    chart: chart('line', buckets.map((b) => M.bucketLabel('week', b)), mcols.map((c) => ({ label: c.label, data: rows.map((r) => r[c.key]), platform: null }))),
    notes: ['Values are the average daily active users of each model within the week. Distinct weekly users are not stored in the rollups.'],
  };
}

function modelsByGroup(ctx, p) {
  const tids = ctx.platforms.filter((i) => platformsMod.byId(i).models);
  const col = p.dim;
  const raw = tids.length ? ctx.db.prepare(
    `SELECT (pe.person_key IS NULL) AS un, pe.${col} AS v, u.platform, u.model, sum(u.cost_usd) AS usd
     FROM usage u LEFT JOIN people pe ON pe.dataset_id = u.dataset_id AND pe.person_key = u.person_key
     WHERE u.dataset_id = ? AND u.date BETWEEN ? AND ? AND u.platform IN (${inList(tids)}) AND coalesce(u.model, '') <> ''
     GROUP BY un, v, u.platform, u.model`
  ).all(ctx.datasetId, ctx.from, ctx.to) : [];
  const byModel = new Map();
  for (const r of raw) {
    const k = `${r.platform}|${r.model}`;
    byModel.set(k, (byModel.get(k) || 0) + num(r.usd));
  }
  const models = Array.from(byModel.entries()).map(([k, usd]) => {
    const [platform, ...rest] = k.split('|');
    return { platform, model: rest.join('|'), usd };
  }).sort((a, b) => b.usd - a.usd || (a.model < b.model ? -1 : 1)).slice(0, 8);
  const mcols = modelColumns(models, 'usd');
  const groups = new Map();
  for (const r of raw) {
    const label = r.un ? 'Unmatched usage' : (r.v === null || UNASSIGNED.has(String(r.v).trim().toLowerCase())) ? 'Unassigned' : r.v;
    if (!groups.has(label)) groups.set(label, { group: label, total: 0, byKey: {} });
    const g = groups.get(label);
    g.total += num(r.usd);
    const c = mcols.find((x) => x.platform === r.platform && x.model === r.model);
    if (c) g.byKey[c.key] = (g.byKey[c.key] || 0) + num(r.usd);
  }
  const all = Array.from(groups.values()).sort((a, b) => b.total - a.total).map((g) => {
    const o = { group: g.group };
    mcols.forEach((c) => { o[c.key] = round2(g.byKey[c.key] || 0); });
    o.total = round2(g.total);
    return o;
  });
  const rows = all.slice(0, p.limit);
  const top = rows.slice(0, 12);
  return {
    columns: [{ key: 'group', label: 'Group', type: 'text' }, ...mcols.map((c) => ({ key: c.key, label: c.label, type: 'money' })), { key: 'total', label: 'Total', type: 'money' }],
    rows, totals: { group: 'Total', total: round2(all.reduce((a, r) => a + r.total, 0)) },
    chart: chart('stacked', top.map((r) => r.group), mcols.map((c) => ({ label: c.label, data: top.map((r) => r[c.key]), platform: null }))),
    notes: ['Total covers all models of the group, including those outside the eight shown.'],
  };
}

// ---- costs ---------------------------------------------------------------------------------

function costsMonthly(ctx) {
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const rows = [];
  for (const w of monthWindows(ctx)) {
    const cur = spendWindow(ctx, seat, w.s, w.e, ids);
    const prev = spendWindow(ctx, seat, w.ps, w.pe, ids);
    const c = ids.reduce((a, id) => a + cur.cons[id], 0);
    const s = ids.reduce((a, id) => a + cur.seat[id], 0);
    const users = M.activeUsers(ctx, w.s, w.e, ids).total;
    rows.push({
      month: monthLabel(w.ym), consumption_usd: round2(c), seat_usd: round2(s), total_usd: round2(c + s),
      delta_total: delta(c + s, basisTotal('total', prev, ids)), active_users: users, usd_per_user: round2(ratio(c + s, users) || 0), month_key: w.ym,
    });
  }
  const sum = (k) => round2(rows.reduce((a, r) => a + r[k], 0));
  return {
    rows, totals: { month: 'Total', consumption_usd: sum('consumption_usd'), seat_usd: sum('seat_usd'), total_usd: sum('total_usd') },
    chart: chart('stacked', rows.map((r) => r.month), [
      { label: 'Consumption', data: rows.map((r) => r.consumption_usd), platform: null },
      { label: 'Seat', data: rows.map((r) => r.seat_usd), platform: null },
    ]),
    notes: [PARTIAL_NOTE, ...seatNote(seat)],
  };
}

function costsByGroup(ctx, p) {
  const c = orgCall(ctx, p.dim, 'consumption', ctx.from, ctx.to);
  const s = orgCall(ctx, p.dim, 'seat', ctx.from, ctx.to);
  const seatBy = new Map(s.rows.map((r) => [r.key, r.total.usd]));
  const merged = c.rows.map((r) => ({ key: r.key, label: r.label, cons: r.total.usd, seat: seatBy.get(r.key) || 0, users: r.total.active_users }));
  for (const r of s.rows) if (!c.rows.some((x) => x.key === r.key)) merged.push({ key: r.key, label: r.label, cons: 0, seat: r.total.usd, users: 0 });
  const grand = merged.reduce((a, r) => a + r.cons + r.seat, 0);
  const all = merged.filter((r) => r.cons !== 0 || r.seat !== 0 || r.users !== 0).map((r) => ({
    group: r.label, consumption_usd: round2(r.cons), seat_usd: round2(r.seat), total_usd: round2(r.cons + r.seat), share: pctOf(r.cons + r.seat, grand) || 0,
    users: r.users, usd_per_user: round2(ratio(r.cons + r.seat, r.users) || 0), key: r.key,
  })).sort((a, b) => b.total_usd - a.total_usd);
  const rows = all.slice(0, p.limit);
  const top = rows.slice(0, 12);
  return {
    rows, totals: {
      group: 'Total', consumption_usd: round2(merged.reduce((a, r) => a + r.cons, 0)), seat_usd: round2(merged.reduce((a, r) => a + r.seat, 0)),
      total_usd: round2(grand), share: 100, users: c.totals.total.active_users,
      usd_per_user: round2(ratio(grand, c.totals.total.active_users) || 0),
    },
    chart: chart('bar', top.map((r) => r.group), [{ label: 'Total spend (USD)', data: top.map((r) => r.total_usd), platform: null }]),
    notes: ['Seat spend is allocated to groups in proportion to their active people each month; seats with no active people sit on Unassigned.', ...seatNote(M.loadSeat(ctx))],
  };
}

function costsMovers(ctx, p) {
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const prevW = M.previousWindow(ctx.from, ctx.to);
  const now = spendWindow(ctx, seat, ctx.from, ctx.to, ids);
  const prev = spendWindow(ctx, seat, prevW.from, prevW.to, ids);
  const items = ids.map((id) => ({
    kind: 'Platform', name: nameOf(id), now: M.pickBasis(ctx.basis, now.cons[id], now.seat[id]), prev: M.pickBasis(ctx.basis, prev.cons[id], prev.seat[id]),
  }));
  const gNow = orgCall(ctx, p.dim, ctx.basis, ctx.from, ctx.to);
  const gPrev = orgCall(ctx, p.dim, ctx.basis, prevW.from, prevW.to);
  const prevBy = new Map(gPrev.rows.map((r) => [r.key, r.total.usd]));
  const seen = new Set();
  for (const r of gNow.rows) {
    seen.add(r.key);
    items.push({ kind: 'Group', name: r.label, now: r.total.usd, prev: prevBy.get(r.key) || 0 });
  }
  for (const r of gPrev.rows) if (!seen.has(r.key)) items.push({ kind: 'Group', name: r.label, now: 0, prev: r.total.usd });
  const all = items.filter((i) => i.now !== 0 || i.prev !== 0).map((i) => ({
    kind: i.kind, name: i.name, now: round2(i.now), prev: round2(i.prev), delta: delta(i.now, i.prev), pct: pctOf(i.now - i.prev, i.prev),
  })).sort((a, b) => Math.abs(b.delta.delta) - Math.abs(a.delta.delta) || (a.name < b.name ? -1 : 1));
  const rows = all.slice(0, p.limit);
  const top = rows.slice(0, 10);
  return {
    rows, totals: null,
    chart: chart('bar', top.map((r) => r.name), [{ label: 'Change (USD)', data: top.map((r) => r.delta.delta), platform: null }]),
    notes: [`Compares ${M.dateLong(ctx.from)} to ${M.dateLong(ctx.to)} with ${M.dateLong(prevW.from)} to ${M.dateLong(prevW.to)}. Spend follows the ${ctx.basis} basis.`, ...seatNote(seat)],
  };
}

function costsPerUser(ctx) {
  const ids = ctx.platforms;
  const seat = M.loadSeat(ctx);
  const w = spendWindow(ctx, seat, ctx.from, ctx.to, ids);
  const cs = M.consumptionByPlatform(ctx, ctx.from, ctx.to, ids);
  const au = M.activeUsers(ctx, ctx.from, ctx.to, ids);
  const rows = ids.map((id) => {
    const usd = M.pickBasis(ctx.basis, w.cons[id], w.seat[id]);
    const n = au.byPlatform[id];
    return {
      platform: id, active_users: n, usd: round2(usd), usd_per_user: round2(ratio(usd, n) || 0),
      consumption_per_user: cons(id, ratio(cs[id].consumption, n) || 0),
    };
  });
  return {
    rows, totals: null,
    chart: chart('bar', rows.map((r) => nameOf(r.platform)), [{ label: 'Spend per user (USD)', data: rows.map((r) => r.usd_per_user), platform: null }]),
    notes: ['Consumption per user is in each platform own unit and is never added across platforms.', `Spend follows the ${ctx.basis} basis.`, ...seatNote(seat)],
  };
}

const RUNNERS = {
  users_top: usersTop, users_new: usersNew, users_inactive: usersInactive, users_multi_platform: usersMulti,
  users_by_group: usersByGroup, users_unmatched: usersUnmatched, platforms_summary: platformsSummary,
  platforms_monthly: platformsMonthly, platforms_freshness: platformsFreshness, platforms_seat_utilisation: platformsSeatUtilisation,
  models_cost: modelsCost, models_adoption: modelsAdoption, models_by_group: modelsByGroup, costs_monthly: costsMonthly,
  costs_by_group: costsByGroup, costs_movers: costsMovers, costs_per_user: costsPerUser,
};

function parseParams(def, q) {
  const p = {};
  if (def.params.includes('dim')) {
    const dim = M.first(q.dim) || 'lob_cg';
    if (!DIMS.includes(dim)) throw badRequest('dim must be lob_cg, region, sbl or person_type');
    p.dim = dim;
  }
  if (def.params.includes('limit')) {
    const raw = M.first(q.limit);
    const n = raw === undefined || raw === '' ? 50 : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw badRequest('limit must be a whole number from 1 to 500');
    p.limit = n;
  }
  return p;
}

function run(id, query) {
  const def = catalog.get(id);
  if (!def) throw notFound('Report');
  const q = query || {};
  const p = parseParams(def, q);
  const ctx = M.resolve(q);
  if (!def.params.includes('platform')) { ctx.platforms = platformsMod.IDS.slice(); ctx.allPlatforms = true; }
  const out = RUNNERS[id](ctx, p, q);
  const params = {};
  if (def.params.includes('range')) { params.from = ctx.from; params.to = ctx.to; }
  if (def.params.includes('platform')) params.platform = ctx.platforms;
  if (def.params.includes('basis')) params.basis = ctx.basis;
  if (def.params.includes('dim')) params.dim = p.dim;
  if (def.params.includes('limit')) params.limit = p.limit;
  return {
    id: def.id, title: def.title, description: def.description, asOf: ctx.asOf, range: { from: ctx.from, to: ctx.to }, params,
    columns: out.columns || def.columns, rows: out.rows, totals: out.totals || null, chart: out.chart || null, notes: out.notes || [],
  };
}

module.exports = { run, RUNNERS };
