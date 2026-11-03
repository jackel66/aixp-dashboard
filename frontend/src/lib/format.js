// Number and date formatting. Money is compact above $1,000. Consumption always carries its unit word.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e7) return sign + '$' + (a / 1e6).toFixed(0) + 'M';
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return sign + '$' + Math.round(a / 1e3) + 'K';
  if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
  return sign + '$' + Math.round(a);
}
export function moneyFull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
export function moneyCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function count(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-';
}
export function compactCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
// units(n, 'tokens') -> "31.4B tokens"; the unit word is always appended.
export function units(v, unit) {
  return compactCount(v) + ' ' + (unit || '');
}
export function pct(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) + '%' : '-';
}
export function pctChange(cur, prev) {
  const c = Number(cur); const p = Number(prev);
  if (prev === null || prev === undefined || !Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
}
function parts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
export function dateLong(s) {
  const p = parts(s);
  return p ? p.d + ' ' + MON[p.m - 1] + ' ' + p.y : '-';
}
export function dateShort(s) {
  const p = parts(s);
  return p ? p.d + ' ' + MON[p.m - 1] : '-';
}
export function lag(days, stale) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 'current';
  if (stale) return 'stale (' + n + ' days)';
  return n + (n === 1 ? ' day behind' : ' days behind');
}
// Date arithmetic on YYYY-MM-DD strings, UTC so no timezone drift.
export function addDays(s, n) {
  const p = parts(s);
  if (!p) return s;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return d.toISOString().slice(0, 10);
}
export function perMillion(usdPerUnit) {
  const n = Number(usdPerUnit);
  return Number.isFinite(n) ? '$' + (n * 1e6).toFixed(2) : '-';
}
