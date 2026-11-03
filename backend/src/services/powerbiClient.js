'use strict';
// Power BI REST client (CONTRACT section 13). Azure AD client credentials or a pasted bearer
// token, executeQueries with 100,000 row cap detection, retries on 429/5xx, at most four
// requests in flight. Secrets are read from settings at call time and never logged or returned.
const crypto = require('crypto');
const settings = require('./settings');
const { HttpError } = require('../errors');

const SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const MAX_IN_FLIGHT = 4;
const RETRIES = 3;

let rowCap = 100000; // tests lower it through setRowCap()
let backoffMs = 500; // tests lower it through setBackoff()
let tokenCache = null;

const stats = { calls: 0, inFlight: 0, maxInFlight: 0, retries: 0 };

function setRowCap(n) { rowCap = n === undefined || n === null ? 100000 : n; }
function getRowCap() { return rowCap; }
function setBackoff(ms) { backoffMs = ms; }
function resetStats() { stats.calls = 0; stats.maxInFlight = stats.inFlight; stats.retries = 0; }
function clearTokenCache() { tokenCache = null; }

const loginBase = () => (process.env.POWERBI_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const apiBase = () => (process.env.POWERBI_API_URL || 'https://api.powerbi.com').replace(/\/+$/, '');

// ---- concurrency: at most MAX_IN_FLIGHT requests at once --------------------------------

let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_IN_FLIGHT) { active += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next(); else active -= 1;
}
async function limited(fn) {
  await acquire();
  stats.inFlight += 1;
  if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
  try { return await fn(); } finally { stats.inFlight -= 1; release(); }
}

// ---- configuration ----------------------------------------------------------------------

function readSecret(key) {
  try { return settings.getSecret(key); } catch (e) {
    throw new HttpError(500, `The stored ${key} cannot be read with the current secret key. Enter it again in Settings.`);
  }
}

function cfg() {
  return {
    authMode: settings.get('powerbi.auth_mode', 'service_principal'),
    tenant: String(settings.get('powerbi.tenant_id', '') || ''),
    clientId: String(settings.get('powerbi.client_id', '') || ''),
    workspace: String(settings.get('powerbi.workspace_id', '') || ''),
    dataset: String(settings.get('powerbi.dataset_id', '') || ''),
    secret: readSecret('powerbi.client_secret'),
    token: readSecret('powerbi.token'),
  };
}

function redactor(c) {
  const bad = [c.secret, c.token].filter((s) => s && s.length >= 4);
  return (text) => {
    let t = String(text);
    for (const s of bad) t = t.split(s).join('***');
    return t;
  };
}

const upstream = (m) => new HttpError(502, m);

// ---- HTTP with retries ------------------------------------------------------------------

function errorText(json, text) {
  let msg = '';
  if (json && typeof json === 'object') {
    const e = json.error;
    if (typeof e === 'string') msg = json.error_description ? `${e}: ${json.error_description}` : e;
    else if (e && typeof e === 'object') {
      msg = [e.code, e.message].filter(Boolean).join(': ');
      const det = e['pbi.error'] && Array.isArray(e['pbi.error'].details) ? e['pbi.error'].details : [];
      const extra = det.map((d) => d && d.detail && d.detail.value).filter(Boolean)[0];
      if (extra && !msg.includes(extra)) msg += msg ? ` (${extra})` : extra;
    } else if (json.message) msg = String(json.message);
  }
  if (!msg) msg = String(text || '').replace(/\s+/g, ' ').trim();
  return msg.slice(0, 400);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One logical request: the attempt itself holds a slot, the back-off wait does not.
async function request(url, init, redact, what) {
  let last = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res = null;
    let text = '';
    try {
      stats.calls += 1;
      const out = await limited(async () => {
        const r = await fetch(url, init);
        return { r, t: await r.text() };
      });
      res = out.r;
      text = out.t;
    } catch (e) {
      last = upstream(redact(`${what} could not reach ${new URL(url).host}: ${e && e.cause && e.cause.code ? e.cause.code : e.message}`));
      if (attempt < RETRIES) { stats.retries += 1; await sleep(backoffMs * 2 ** attempt); continue; }
      throw last;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json, text };
    const detail = redact(errorText(json, text));
    if (res.status === 429 || res.status >= 500) {
      last = upstream(`${what} failed (HTTP ${res.status}): ${detail || 'no detail'}`);
      if (attempt < RETRIES) {
        stats.retries += 1;
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : backoffMs * 2 ** attempt;
        await sleep(wait);
        continue;
      }
      throw last;
    }
    const e = upstream(
      res.status === 401 || res.status === 403
        ? `${what} was refused (HTTP ${res.status}): ${detail || 'no detail from the service'}`
        : `${what} failed (HTTP ${res.status}): ${detail || 'no detail'}`
    );
    e.upstreamStatus = res.status;
    throw e;
  }
  throw last || upstream(`${what} failed`);
}

// ---- token ------------------------------------------------------------------------------

// -> {token, expires_in}. expires_in is seconds left, or null for a pasted token.
async function getToken(c) {
  const conf = c || cfg();
  const redact = redactor(conf);
  if (conf.authMode === 'token') {
    if (!conf.token) throw upstream('No bearer token is stored. Paste one in Settings.');
    return { token: conf.token, expires_in: null };
  }
  const missing = ['tenant', 'clientId', 'secret'].filter((k) => !conf[k]);
  if (missing.length) {
    const names = { tenant: 'tenant id', clientId: 'client id', secret: 'client secret' };
    throw upstream(`Power BI sign-in is missing: ${missing.map((k) => names[k]).join(', ')}`);
  }
  const key = crypto.createHash('sha256').update([conf.tenant, conf.clientId, conf.secret].join('|')).digest('hex');
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt - 5 * 60000 > Date.now()) {
    return { token: tokenCache.token, expires_in: Math.round((tokenCache.expiresAt - Date.now()) / 1000) };
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: conf.clientId, client_secret: conf.secret, scope: SCOPE,
  }).toString();
  let out;
  try {
    out = await request(
      `${loginBase()}/${encodeURIComponent(conf.tenant)}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      redact, 'Azure AD sign-in'
    );
  } catch (e) {
    console.warn(`[powerbi] ${redact(e.message)}`);
    throw e;
  }
  const j = out.json || {};
  if (!j.access_token) throw upstream('Azure AD sign-in answered without an access token');
  const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
  tokenCache = { key, token: j.access_token, expiresAt: Date.now() + ttl * 1000 };
  return { token: j.access_token, expires_in: ttl };
}

async function authedRequest(method, path, bodyObj, what) {
  const c = cfg();
  const redact = redactor(c);
  const doIt = async () => {
    const t = await getToken(c);
    const init = { method, headers: { Authorization: `Bearer ${t.token}` } };
    if (bodyObj !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(bodyObj); }
    return request(`${apiBase()}${path}`, init, redact, what);
  };
  try {
    return await doIt();
  } catch (e) {
    // A cached token can be revoked early; sign in again once before giving up.
    if (e.upstreamStatus === 401 && c.authMode === 'service_principal') {
      clearTokenCache();
      return doIt();
    }
    throw e;
  }
}

function needIds(c, withDataset) {
  if (!c.workspace) throw upstream('powerbi.workspace_id is not set');
  if (withDataset && !c.dataset) throw upstream('powerbi.dataset_id is not set');
}

// ---- public calls -----------------------------------------------------------------------

// Rows of the first table of the first result. DAX errors come back as an upstream error.
async function executeQuery(dax) {
  const c = cfg();
  needIds(c, true);
  const path = `/v1.0/myorg/groups/${encodeURIComponent(c.workspace)}/datasets/${encodeURIComponent(c.dataset)}/executeQueries`;
  const out = await authedRequest('POST', path, { queries: [{ query: dax }], serializerSettings: { includeNulls: true } }, 'Power BI query');
  const r0 = out.json && Array.isArray(out.json.results) ? out.json.results[0] : null;
  if (r0 && r0.error) throw upstream(redactor(c)(`Power BI query failed: ${errorText({ error: r0.error }, '')}`));
  const t0 = r0 && Array.isArray(r0.tables) ? r0.tables[0] : null;
  return t0 && Array.isArray(t0.rows) ? t0.rows : [];
}

// True when a chunk answered with as many rows as one query may return, so it may be cut short.
function isCapped(rows) { return rows.length >= rowCap; }

async function listDatasets() {
  const c = cfg();
  needIds(c, false);
  const out = await authedRequest('GET', `/v1.0/myorg/groups/${encodeURIComponent(c.workspace)}/datasets`, undefined, 'Power BI dataset list');
  const list = out.json && Array.isArray(out.json.value) ? out.json.value : [];
  return list.map((d) => ({ id: String(d.id), name: String(d.name == null ? '' : d.name) }));
}

// Best effort: the workspace name, or null when the principal may not read it.
async function workspaceName() {
  const c = cfg();
  try {
    const q = encodeURIComponent(`id eq '${c.workspace}'`);
    const out = await authedRequest('GET', `/v1.0/myorg/groups?$filter=${q}`, undefined, 'Power BI workspace lookup');
    const v = out.json && Array.isArray(out.json.value) ? out.json.value[0] : null;
    return v && v.name ? String(v.name) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  executeQuery, isCapped, listDatasets, workspaceName, getToken, cfg,
  setRowCap, getRowCap, setBackoff, clearTokenCache, resetStats, stats, MAX_IN_FLIGHT,
};
