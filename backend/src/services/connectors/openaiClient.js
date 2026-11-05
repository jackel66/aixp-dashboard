'use strict';
// OpenAI client (CONTRACT section 18.4). Plain fetch, no SDK. Two hosts: the API platform (Admin API key,
// organization usage, costs and users) and ChatGPT Enterprise (workspace Admin key, hourly per-user credits
// and estimated USD). Paced at 500 ms between calls, 429 Retry-After honoured, 429 and 5xx retried three times.
// Keys are read from settings at call time and never logged. The Enterprise costs route is UNVERIFIED.
const settings = require('../settings');
const { HttpError } = require('../../errors');

const RETRIES = 3;
const USAGE_LIMIT = 31;
const COSTS_LIMIT = 180;
const USERS_LIMIT = 100;
const ENT_LIMIT = 500;
const MAX_PAGES = 500;

let paceMs = 500;
let backoffMs = 1000;
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let clockFn = () => Date.now();
let lastCall = -Infinity;
const stats = { calls: 0, retries: 0 };

// Tests inject a fake clock and sleep so pacing can be asserted without waiting.
function setSleep(fn) { sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }
function setClock(fn) { clockFn = fn || (() => Date.now()); }
function setPace(ms) { paceMs = ms === undefined || ms === null ? 500 : ms; }
function setBackoff(ms) { backoffMs = ms === undefined || ms === null ? 1000 : ms; }
function resetPacer() { lastCall = -Infinity; }
function resetStats() { stats.calls = 0; stats.retries = 0; }

const SECRET_NAME = { api: 'openai.admin_key', ent: 'openai.enterprise_key' };

function readSecret(which) {
  try { return settings.getSecret(SECRET_NAME[which]); } catch (e) {
    throw new HttpError(500, `The stored ${SECRET_NAME[which]} cannot be read with the current secret key. Enter it again in Settings.`);
  }
}

const trimUrl = (v, dflt) => String(v || dflt).replace(/\/+$/, '');
const ENT_PATH = '/v1/compliance/organizations/{org_id}/costs';

function cfg(which) {
  if (which === 'ent') {
    return {
      key: readSecret('ent'),
      base: trimUrl(settings.get('openai.enterprise_base_url', 'https://api.chatgpt.com'), 'https://api.chatgpt.com'),
      orgId: String(settings.get('openai.enterprise_org_id', '') || '').trim(),
      path: String(settings.get('openai.enterprise_costs_path', ENT_PATH) || ENT_PATH),
    };
  }
  return { key: readSecret('api'), base: trimUrl(settings.get('openai.base_url', 'https://api.openai.com'), 'https://api.openai.com') };
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

// A 200 body: one JSON document, or newline-delimited JSON (the Compliance exports are JSONL).
function parseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* try JSONL */ }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (e) { return null; }
  }
  return rows.length ? { data: rows } : null;
}

/**
 * One GET with pacing and retries. `which` is 'api' or 'ent'; `path` starts with /; params are [name, value] pairs.
 * Throws HttpError 502 with .upstreamStatus (and .detail = the vendor message).
 */
async function get(which, path, params) {
  const c = cfg(which);
  const label = which === 'ent' ? 'ChatGPT Enterprise' : 'OpenAI';
  if (!c.key) throw new HttpError(400, `OpenAI is not configured: ${which === 'ent' ? 'enterprise key' : 'admin key'}`);
  const redact = (t) => String(t).split(c.key).join('***');
  const headers = { authorization: `Bearer ${c.key}`, accept: 'application/json' };
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
      lastErr = upstream(0, redact(`${label} request failed: ${e.message}`));
      continue;
    }
    if (res.status === 200) {
      const body = parseBody(text);
      if (!body || typeof body !== 'object') throw upstream(200, `${label} answered 200 with a body that is not JSON`);
      return body;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    const msg = redact(errorText(json, text));
    if (res.status === 401 || res.status === 403) {
      throw upstream(res.status, `${label} refused the key (HTTP ${res.status}): ${msg}`, { detail: msg });
    }
    if (res.status === 429 || res.status >= 500) {
      const raHeader = res.headers.get('retry-after');
      const ra = Number(raHeader);
      lastErr = upstream(res.status, `${label} answered HTTP ${res.status}: ${msg}`, {
        detail: msg, retryAfter: raHeader !== null && Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 120) : null,
      });
      continue;
    }
    throw upstream(res.status, `${label} rejected the request (HTTP ${res.status}): ${msg}`, { detail: msg });
  }
  throw lastErr || upstream(0, `${label} request failed`);
}

const sec = (ms) => Math.floor(ms / 1000);

// Follow next_page while has_more. Returns every bucket.
async function paged(path, base, firstOnly) {
  const buckets = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await get('api', path, page ? base.concat([['page', page]]) : base);
    if (Array.isArray(body.data)) buckets.push(...body.data);
    if (firstOnly || !body.has_more || !body.next_page) break;
    if (body.next_page === page) throw upstream(200, 'OpenAI returned the same page cursor twice');
    page = body.next_page;
  }
  return buckets;
}

// Completions usage per day grouped by user and model for [startMs, endMs). Returns the buckets.
function usageCompletions(startMs, endMs, opts = {}) {
  const base = [['start_time', sec(startMs)], ['end_time', sec(endMs)], ['bucket_width', '1d'], ['limit', opts.limit || USAGE_LIMIT]];
  for (const g of opts.groupBy || ['user_id', 'model']) base.push(['group_by[]', g]);
  return paged('/v1/organization/usage/completions', base, opts.firstPageOnly);
}

// Costs per day for [startMs, endMs). groupBy defaults to user_id; a 400 is left to the caller (it retries by line_item).
function costs(startMs, endMs, opts = {}) {
  const base = [['start_time', sec(startMs)], ['end_time', sec(endMs)], ['bucket_width', '1d'], ['limit', opts.limit || COSTS_LIMIT]];
  for (const g of opts.groupBy || ['user_id']) base.push(['group_by[]', g]);
  return paged('/v1/organization/costs', base, opts.firstPageOnly);
}

// All organization users (id, email, name, nested user.email), following last_id or the last item id.
async function listUsers(opts = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = [['limit', opts.limit || USERS_LIMIT]];
    if (after) params.push(['after', after]);
    const body = await get('api', '/v1/organization/users', params);
    const list = Array.isArray(body.data) ? body.data : [];
    out.push(...list);
    if (opts.firstPageOnly || !body.has_more || !list.length) break;
    const next = body.last_id || (list[list.length - 1] && list[list.length - 1].id);
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

/**
 * ChatGPT Enterprise costs. One or more pages of base + path, query after=<ISO>, limit=500. The cursor is
 * whichever the answer carries: next_page (sent back as page), else has_more with last_end_time (sent as after).
 * Returns {rows (raw records), pages, path}. The shape is UNVERIFIED so records are returned untouched.
 */
async function enterpriseCosts(afterIso, opts = {}) {
  const c = cfg('ent');
  if (!c.key) throw new HttpError(400, 'OpenAI is not configured: enterprise key');
  if (c.path.includes('{org_id}') && !c.orgId) throw new HttpError(400, 'OpenAI is not configured: enterprise org id');
  const path = c.path.split('{org_id}').join(encodeURIComponent(c.orgId));
  const rows = [];
  let after = afterIso;
  let page = null;
  let pages = 0;
  const seen = new Set();
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = [['after', after], ['limit', opts.limit || ENT_LIMIT]];
    if (page) params.push(['page', page]);
    const sig = JSON.stringify(params);
    if (seen.has(sig)) throw upstream(200, 'ChatGPT Enterprise returned the same page cursor twice');
    seen.add(sig);
    const body = await get('ent', path, params);
    pages += 1;
    const list = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : Array.isArray(body.results) ? body.results : null;
    if (list) rows.push(...list); else if (body && typeof body === 'object') rows.push(body);
    if (opts.onPage) opts.onPage(rows.length);
    if (Array.isArray(body) || opts.firstPageOnly) break;
    if (body.next_page) { page = body.next_page; continue; }
    if (body.has_more && body.last_end_time) { after = body.last_end_time; page = null; continue; }
    break;
  }
  return { rows, pages, path };
}

module.exports = {
  USAGE_LIMIT, COSTS_LIMIT, USERS_LIMIT, ENT_LIMIT, ENT_PATH, cfg, get, usageCompletions, costs, listUsers, enterpriseCosts,
  setSleep, setClock, setPace, setBackoff, resetPacer, resetStats, stats,
};
