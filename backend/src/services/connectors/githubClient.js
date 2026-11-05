'use strict';
// GitHub REST client for the Copilot connector (CONTRACT section 18.3). Plain fetch, no SDK.
// Facts from the research: Authorization Bearer, Accept application/vnd.github+json, X-GitHub-Api-Version
// 2022-11-28, Link header pagination (per_page 100), X-RateLimit-Remaining/Reset honoured, 429 and 403
// with Retry-After retried three times. Report downloads (signed URLs) are fetched WITHOUT the token.
// The token is read from settings at call time and never logged.
const settings = require('../settings');
const { HttpError } = require('../../errors');

const API_VERSION = '2022-11-28';
const RETRIES = 3;
const PER_PAGE = 100;
const LOW_WATER = 50;
const MAX_SLEEP_MS = 3600000;

let backoffMs = 1000;
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let clockFn = () => Date.now();
const stats = { calls: 0, retries: 0, rateSleeps: 0 };
const rate = { remaining: null, reset: null, limit: null };

function setSleep(fn) { sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }
function setClock(fn) { clockFn = fn || (() => Date.now()); }
function setBackoff(ms) { backoffMs = ms === undefined || ms === null ? 1000 : ms; }
function resetStats() {
  stats.calls = 0; stats.retries = 0; stats.rateSleeps = 0;
  rate.remaining = null; rate.reset = null; rate.limit = null;
}

function readSecret() {
  try { return settings.getSecret('github.token'); } catch (e) {
    throw new HttpError(500, 'The stored github.token cannot be read with the current secret key. Enter it again in Settings.');
  }
}

function cfg() {
  return {
    token: readSecret(),
    base: String(settings.get('github.base_url', 'https://api.github.com') || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

function errorText(json, text) {
  if (json && typeof json === 'object' && json.message) return String(json.message);
  return String(text || '').slice(0, 300);
}

function upstream(status, message, extra) {
  const e = new HttpError(502, message);
  e.upstreamStatus = status;
  return Object.assign(e, extra || {});
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of params || []) if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
  const s = q.toString();
  return s ? '?' + s : '';
}

function noteRate(headers) {
  const rem = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const lim = headers.get('x-ratelimit-limit');
  if (rem !== null && Number.isFinite(Number(rem))) rate.remaining = Number(rem);
  if (reset !== null && Number.isFinite(Number(reset))) rate.reset = Number(reset);
  if (lim !== null && Number.isFinite(Number(lim))) rate.limit = Number(lim);
}

// Sleep to the reset time when the budget is nearly gone (remaining < 50).
async function respectBudget() {
  if (rate.remaining !== null && rate.remaining < LOW_WATER && rate.reset) {
    const wait = Math.min(MAX_SLEEP_MS, Math.max(0, rate.reset * 1000 - clockFn()) + 1000);
    rate.remaining = null; // the next response refreshes it
    if (wait > 0) { stats.rateSleeps += 1; await sleepFn(wait); }
  }
}

function nextLink(header) {
  if (!header) return null;
  for (const part of String(header).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * One GET with budget handling and retries. `target` is a path (joined to the base URL) or an absolute URL
 * on the same origin as the base (Link header targets). Returns {json, headers}. Errors: HttpError 502 with
 * .upstreamStatus; a 404 carries .notFound = true.
 */
async function request(target, params) {
  const c = cfg();
  if (!c.token) throw new HttpError(400, 'GitHub is not configured: token');
  const redact = (t) => String(t).split(c.token).join('***');
  const headers = {
    authorization: 'Bearer ' + c.token,
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'aixp-dashboard',
  };
  let url;
  if (/^https?:\/\//i.test(target)) {
    if (new URL(target).origin !== new URL(c.base).origin) throw upstream(0, 'GitHub returned a link to a different host; not followed');
    url = target;
  } else url = c.base + target + query(params);
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      stats.retries += 1;
      const ra = lastErr && lastErr.retryAfter;
      await sleepFn(ra !== undefined && ra !== null ? ra * 1000 : backoffMs * 2 ** (attempt - 1));
    }
    await respectBudget();
    stats.calls += 1;
    let res;
    let text;
    try {
      res = await fetch(url, { method: 'GET', headers });
      text = await res.text();
    } catch (e) {
      lastErr = upstream(0, redact('GitHub request failed: ' + e.message));
      continue;
    }
    noteRate(res.headers);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (res.status === 200) {
      if (json === null || typeof json !== 'object') throw upstream(200, 'GitHub answered 200 with a body that is not JSON');
      return { json, headers: res.headers };
    }
    const msg = redact(errorText(json, text));
    const raHeader = res.headers.get('retry-after');
    const ra = Number(raHeader);
    const retryAfter = raHeader !== null && Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 120) : null;
    if (res.status === 429 || (res.status === 403 && (retryAfter !== null || rate.remaining === 0))) {
      lastErr = upstream(res.status, 'GitHub rate limited the request (HTTP ' + res.status + '): ' + msg, { retryAfter });
      continue;
    }
    if (res.status === 401 || res.status === 403) throw upstream(res.status, 'GitHub refused the token (HTTP ' + res.status + '): ' + msg);
    if (res.status === 404) throw upstream(404, 'GitHub answered HTTP 404: ' + msg, { notFound: true });
    if (res.status >= 500) { lastErr = upstream(res.status, 'GitHub answered HTTP ' + res.status + ': ' + msg, { retryAfter }); continue; }
    throw upstream(res.status, 'GitHub rejected the request (HTTP ' + res.status + '): ' + msg);
  }
  throw lastErr || upstream(0, 'GitHub request failed');
}

const get = async (path, params) => (await request(path, params)).json;

/**
 * Every item of a paged list. `key` names the array inside an object body (null = the body is the array).
 * Follows the Link header; stops at opts.max items when given. per_page 100.
 */
async function paged(path, params, key, opts = {}) {
  const out = [];
  let target = path;
  let p = [['per_page', PER_PAGE]].concat(params || []);
  for (let i = 0; i < 500; i++) {
    const { json, headers } = await request(target, p);
    const list = Array.isArray(json) ? json : key && Array.isArray(json[key]) ? json[key] : [];
    out.push(...list);
    if (opts.max && out.length >= opts.max) return out.slice(0, opts.max);
    const next = nextLink(headers.get('link'));
    if (!next || next === target) break;
    target = next;
    p = null;
  }
  return out;
}

// Download an NDJSON report file from a signed URL. No Authorization header (the URL carries its own grant).
async function ndjson(url) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) { stats.retries += 1; await sleepFn(backoffMs * 2 ** (attempt - 1)); }
    stats.calls += 1;
    let res;
    let text;
    try {
      res = await fetch(url, { method: 'GET', headers: { 'user-agent': 'aixp-dashboard' } });
      text = await res.text();
    } catch (e) { lastErr = upstream(0, 'Report download failed: ' + e.message); continue; }
    if (res.status === 200) {
      const rows = [];
      let bad = 0;
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { const o = JSON.parse(t); if (o && typeof o === 'object') rows.push(o); } catch (e) { bad += 1; }
      }
      // A whole-file JSON array is tolerated in case the format differs from the documented NDJSON.
      if (!rows.length && bad) {
        try {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) return { rows: arr.filter((x) => x && typeof x === 'object'), bad: 0 };
        } catch (e) { /* fall through */ }
      }
      return { rows, bad };
    }
    if (res.status >= 500 || res.status === 429) { lastErr = upstream(res.status, 'Report download answered HTTP ' + res.status); continue; }
    throw upstream(res.status, 'Report download answered HTTP ' + res.status);
  }
  throw lastErr || upstream(0, 'Report download failed');
}

module.exports = {
  API_VERSION, PER_PAGE, cfg, request, get, paged, ndjson, nextLink, rate, stats,
  setSleep, setClock, setBackoff, resetStats,
};
