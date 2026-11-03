'use strict';
// Time helpers. The team works in America/Phoenix (no DST).

const TZ = 'America/Phoenix';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let override = null;

// Tests can pin the clock. Pass null to release.
function setNow(d) {
  override = d ? new Date(d) : null;
}
function now() {
  return override ? new Date(override.getTime()) : new Date();
}
function nowIso() {
  return now().toISOString();
}

function phoenixParts(d) {
  const parts = {};
  for (const p of fmt.formatToParts(d || now())) parts[p.type] = p.value;
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    weekday: WEEKDAYS[parts.weekday],
    year: parseInt(parts.year, 10),
  };
}

function todayPhoenix(d) {
  return phoenixParts(d).date;
}

function dateToUtcMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function msToDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  return msToDate(dateToUtcMs(dateStr) + n * 86400000);
}
// Whole days from a to b (b - a), both YYYY-MM-DD.
function diffDays(a, b) {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / 86400000);
}
function mondayOf(dateStr) {
  const wd = new Date(dateToUtcMs(dateStr)).getUTCDay();
  return addDays(dateStr, -((wd + 6) % 7));
}
function weekLabel(weekStart) {
  const [, m, d] = weekStart.split('-').map(Number);
  return `Week of ${m}.${d}`;
}

module.exports = {
  TZ, setNow, now, nowIso, phoenixParts, todayPhoenix, addDays, diffDays,
  mondayOf, weekLabel,
};
