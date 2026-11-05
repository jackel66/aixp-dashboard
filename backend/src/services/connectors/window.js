'use strict';
// Pull window arithmetic shared by the vendor importer and the connectors' test steps (CONTRACT 16.1).
// All dates are YYYY-MM-DD (UTC days).
const DAY = 86400000;

const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => toDate(toMs(d) + n * DAY);
const maxDate = (a, b) => (a > b ? a : b);

// First day of the month `monthsBack` months before the month of `today`.
function monthsBackStart(today, monthsBack) {
  const [y, m] = today.split('-').map(Number);
  return toDate(Date.UTC(y, m - 1 - monthsBack, 1));
}

/**
 * from = max(history_floor, month start months_back ago, today - maxDaysBack + 1) when there is no
 * previous pull for the platform, else max(history_floor, lastDay - rebuildDays, ...same retention).
 * opts: {floor, monthsBack, rebuildDays, lastDay (or null), maxDaysBack (or null), today}
 */
function planFrom(opts) {
  let from = opts.lastDay ? addDays(opts.lastDay, -opts.rebuildDays) : monthsBackStart(opts.today, opts.monthsBack);
  from = maxDate(from, opts.floor);
  if (opts.maxDaysBack) from = maxDate(from, addDays(opts.today, -(opts.maxDaysBack - 1)));
  return from;
}

// Whole-hour end of the window: now floored to the hour, as an ISO string (exclusive end).
function endNow(nowDate) {
  const d = new Date(nowDate);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// Slices of at most `maxDays` days: [{startMs, endMs}] covering [from 00:00Z, endIso).
function slices(from, endIso, maxDays = 31) {
  const start = toMs(from);
  let end = Date.parse(endIso);
  if (!(end > start)) end = start + 3600000;
  const out = [];
  for (let s = start; s < end; s += maxDays * DAY) out.push({ startMs: s, endMs: Math.min(end, s + maxDays * DAY) });
  return out;
}

module.exports = { DAY, toMs, toDate, addDays, maxDate, monthsBackStart, planFrom, endNow, slices };
