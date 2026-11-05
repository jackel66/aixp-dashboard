'use strict';
// Anthropic Enterprise Analytics client (CONTRACT section 16.2). Plain fetch, no SDK.
// Facts from the research: x-api-key = Analytics key (read:analytics), anthropic-version header,
// anthropic-beta: analytics-usage-cost-2026-08-24 on /analytics/cost and /analytics/usage,
// 60 requests a minute per organization (paced at 1,000 ms), 410 = cursor expired (restart the window),
// 429 and 5xx retry three times. The key is read from settings at call time and never logged.
const settings = require('../settings');
const { HttpError } = require('../../errors');

const BETA = 'analytics-usage-cost-2026-08-24';
const RETRIES = 3;
const PAGE_RESTARTS = 3;
const LIMIT = 1000;

let paceMs = 1000;
let backoffMs = 1000;
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let clockFn = () => Date.now();
let lastCall = -Infinity;
const stats = { calls: 0, retries: 0, restarts: 0 };

// Tests inject a fake clock and sleep so pacing can be asserted without waiting.
function setSleep(fn) { sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }
function setClock(fn) { clockFn = fn || (() => Date.now()); }
function setPace(ms) { paceMs = ms === undefined || ms === null ? 1000 : ms; }
function setBackoff(ms) { backoffMs = ms === undefined || ms === null ? 1000 : ms; }
function resetPacer() { lastCall = -Infinity; }
function resetStats() { stats.calls = 0; stats.retries = 0; stats.restarts = 0; }

function readSecret() {
  try { return settings.getSecret('anthropic.api_key'); } catch (e) {
    throw new HttpError(500, 'The stored anthropic.api_key cannot be read with the current secret key. Enter it again in Settings.');
  }
}

function cfg() {
  return {
    key: readSecret(),
    base: String(settings.get('anthropic.base_url', 'https://api.anthropic.com') || 'https://api.anthropic.com').replace(/\/+$/, ''),
    version: String(settings.get('anthropic.anthropic_version', '2026-10-21') || '2026-10-21'),
  };
}

async function pace() {
  const wait = lastCall + paceMs - clockFn();
  if (wait > 0) await sleepFn(wait);
  lastCall = clockFn();
}

function errorText(json, text) {
  if (json && typeof json === 'object') {
    if (json.error && typeof json.error === 'object' && json.error.message) return String(json.error.message);
    if (typeof json.error === 'string') return json.error;
    if (json.message) return String(json.message);
  }
  return String(text || '').slice(0, 300);
}

function upstream(status, message, extra) {
  const e = new HttpError(502, message);
  e.upstreamStatus = status;
  return Object.assign(e, extra || {});
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of params) if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
  const s = q.toString();
  return s ? '?' + s : '';
}

/**
 * One GET with pacing and retries. params: array of [name, value] pairs (repeats allowed).
 * Throws HttpError 502 with .upstreamStatus; a 410 throws with .expired = true.
 */
async function get(path, params, opts = {}) {
  const c = cfg();
  if (!c.key) throw new HttpError(400, 'Anthropic is not configured: api key');
  const redact = (t) => String(t).split(c.key).join('***');
  const headers = { 'x-api-key': c.key, 'anthropic-version': c.version, accept: 'application/json' };
  if (opts.beta) headers['anthropic-beta'] = BETA;
  const url = c.base + path + query(params || []);
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      stats.retries += 1;
      const ra = lastErr && lastErr.retryAfter;
      await sleepFn(ra !== undefined && ra !== null ? ra * 1000 : backoffMs * 2 ** (attempt - 1));
    }
    await pace();
    stats.calls += 1;
    let res;
    let text;
    try {
      res = await fetch(url, { method: 'GET', headers });
      text = await res.text();
    } catch (e) {
      lastErr = upstream(0, redact('Anthropic request failed: ' + e.message));
      continue;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (res.status === 200) {
      if (!json || typeof json !== 'object') throw upstream(200, 'Anthropic answered 200 with a body that is not JSON');
      return json;
    }
    const msg = redact(errorText(json, text));
    if (res.status === 401 || res.status === 403) {
      throw upstream(res.status, 'Anthropic refused the key (HTTP ' + res.status + '): ' + msg);
    }
    if (res.status === 410) throw upstream(410, 'Anthropic cursor expired (HTTP 410): ' + msg, { expired: true });
    if (res.status === 429 || res.status >= 500) {
      const raHeader = res.headers.get('retry-after');
      const ra = Number(raHeader);
      lastErr = upstream(res.status, 'Anthropic answered HTTP ' + res.status + ': ' + msg, {
        retryAfter: raHeader !== null && Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 120) : null,
      });
      continue;
    }
    throw upstream(res.status, 'Anthropic rejected the request (HTTP ' + res.status + '): ' + msg);
  }
  throw lastErr || upstream(0, 'Anthropic request failed');
}

const rfc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * All rows of /analytics/cost or /analytics/usage for [startMs, endMs). opts: {bucket: '1d' | null,
 * groupBy: [..], actorTypes: [..], limit, onPage(rowsSoFar)}. A 410 restarts the window from page one.
 * Returns {rows, data_refreshed_at, pages}.
 */
async function analytics(kind, startMs, endMs, opts = {}) {
  const base = [['starting_at', rfc(startMs)], ['ending_at', rfc(endMs)]];
  if (opts.bucket) base.push(['time_bucket_width', opts.bucket]);
  for (const g of opts.groupBy || []) base.push(['group_by[]', g]);
  for (const a of opts.actorTypes || []) base.push(['actor_types[]', a]);
  base.push(['limit', opts.limit || LIMIT]);
  for (let restart = 0; restart <= PAGE_RESTARTS; restart++) {
    const rows = [];
    let page = null;
    let refreshed = null;
    let pages = 0;
    let expired = false;
    for (;;) {
      const params = page ? base.concat([['page', page]]) : base;
      let body;
      try {
        body = await get('/v1/organizations/analytics/' + kind, params, { beta: true });
      } catch (e) {
        if (e.expired && restart < PAGE_RESTARTS) { expired = true; stats.restarts += 1; break; }
        throw e;
      }
      pages += 1;
      if (Array.isArray(body.data)) rows.push(...body.data);
      if (body.data_refreshed_at) refreshed = body.data_refreshed_at;
      if (opts.onPage) opts.onPage(rows.length);
      if (!body.has_more || !body.next_page) break;
      if (body.next_page === page) throw upstream(200, 'Anthropic returned the same page cursor twice');
      page = body.next_page;
    }
    if (!expired) return { rows, data_refreshed_at: refreshed, pages };
  }
  throw upstream(410, 'Anthropic cursor kept expiring (HTTP 410); try the pull again later');
}

// Organization total for the window: one unbucketed cost call with no group_by. Returns USD cents summed.
async function orgTotalCents(startMs, endMs) {
  const r = await analytics('cost', startMs, endMs, { bucket: null, groupBy: [], actorTypes: [] });
  let cents = 0;
  for (const row of r.rows) cents += Number(row && row.cost && row.cost.amount) || 0;
  return { cents, data_refreshed_at: r.data_refreshed_at };
}

// Follow next_page when a list answers has_more (shape of the group endpoints beyond data is UNVERIFIED).
async function listAll(path, key) {
  const out = [];
  let page = null;
  for (let i = 0; i < 200; i++) {
    const body = await get(path, page ? [['page', page]] : [], {});
    const list = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : Array.isArray(body[key]) ? body[key] : [];
    out.push(...list);
    if (Array.isArray(body) || !body.has_more || !body.next_page || body.next_page === page) break;
    page = body.next_page;
  }
  return out;
}

const listGroups = () => listAll('/v1/organizations/rbac_groups', 'groups');
const listGroupMembers = (id) => listAll('/v1/organizations/rbac_groups/' + encodeURIComponent(id) + '/members', 'members');

module.exports = {
  BETA, LIMIT, cfg, get, analytics, orgTotalCents, listGroups, listGroupMembers, rfc,
  setSleep, setClock, setPace, setBackoff, resetPacer, resetStats, stats,
};
