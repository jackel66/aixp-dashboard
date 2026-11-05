'use strict';
// Microsoft Graph and Entra client for the Copilot Cowork connector (CONTRACT section 18.5). Plain fetch.
// Two tokens: an app-only token (client credentials, Reports.Read.All and User.Read.All) and a delegated
// token from the stored refresh token (device code flow, public client). Paced at 200 ms; 429 and 503 honour
// Retry-After. Secrets and tokens are read from settings at call time and never logged or put in messages.
const settings = require('../settings');
const secrets = require('../secrets');
const { HttpError } = require('../../errors');

const DELEGATED_SCOPE = 'offline_access https://graph.microsoft.com/CopilotCostManagement-UserData.Read.All '
  + 'https://graph.microsoft.com/CopilotCostManagement.Read.All https://graph.microsoft.com/User.Read';
const APP_SCOPE = 'https://graph.microsoft.com/.default';
const RETRIES = 3;
const BATCH_MAX = 20;
const USER_SELECT = 'id,userPrincipalName,mail,displayName,department,companyName,officeLocation';

let paceMs = 200;
let backoffMs = 1000;
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let clockFn = () => Date.now();
let lastCall = -Infinity;
const stats = { calls: 0, retries: 0, batches: 0 };
let appCache = null; // {sig, token, exp}
let delCache = null; // {sig, token, exp}

function setSleep(fn) { sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }
function setClock(fn) { clockFn = fn || (() => Date.now()); }
function setPace(ms) { paceMs = ms === undefined || ms === null ? 200 : ms; }
function setBackoff(ms) { backoffMs = ms === undefined || ms === null ? 1000 : ms; }
function resetPacer() { lastCall = -Infinity; }
function resetStats() { stats.calls = 0; stats.retries = 0; stats.batches = 0; }
function resetTokens() { appCache = null; delCache = null; }
const now = () => clockFn();

function secret(key) {
  try { return settings.getSecret(key); } catch (e) {
    throw new HttpError(500, `The stored ${key} cannot be read with the current secret key. Enter it again in Settings.`);
  }
}

function cfg() {
  const trim = (v, d) => String(v || d).replace(/\/+$/, '');
  return {
    tenant: String(settings.get('cowork.tenant_id', '') || '').trim(),
    clientId: String(settings.get('cowork.client_id', '') || '').trim(),
    clientSecret: secret('cowork.client_secret'),
    refreshToken: secret('cowork.refresh_token'),
    graph: trim(settings.get('cowork.graph_base', ''), 'https://graph.microsoft.com'),
    login: trim(settings.get('cowork.login_base', ''), 'https://login.microsoftonline.com'),
  };
}

async function pace() {
  const wait = lastCall + paceMs - clockFn();
  if (wait > 0) await sleepFn(wait);
  lastCall = clockFn();
}

function upstream(status, message, extra) {
  const e = new HttpError(502, message);
  e.upstreamStatus = status;
  return Object.assign(e, extra || {});
}

function errorText(json, text) {
  if (json && typeof json === 'object') {
    if (json.error && typeof json.error === 'object' && json.error.message) return `${json.error.code ? json.error.code + ': ' : ''}${json.error.message}`;
    if (typeof json.error === 'string') return json.error_description ? `${json.error}: ${String(json.error_description).split('\r\n')[0]}` : json.error;
    if (json.message) return String(json.message);
  }
  return String(text || '').slice(0, 300);
}

const redactor = (c) => (t) => {
  let s = String(t);
  for (const v of [c.clientSecret, c.refreshToken]) if (v) s = s.split(v).join('***');
  return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '***');
};

// One HTTP call with pacing and retries on 429, 503 and network errors. Returns {status, text, json, headers, redact}.
// Statuses other than 429 and 503 are returned to the caller.
async function request(url, init, c) {
  const redact = redactor(c);
  let last = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      stats.retries += 1;
      const ra = last && last.retryAfter;
      await sleepFn(ra !== undefined && ra !== null ? ra * 1000 : backoffMs * 2 ** (attempt - 1));
    }
    await pace();
    stats.calls += 1;
    let res;
    let text;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (e) {
      last = upstream(0, redact('Microsoft request failed: ' + e.message));
      continue;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (res.status === 429 || res.status === 503) {
      const raHeader = res.headers.get('retry-after');
      const ra = Number(raHeader);
      last = upstream(res.status, 'Microsoft answered HTTP ' + res.status + ': ' + redact(errorText(json, text)), {
        retryAfter: raHeader !== null && Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 120) : null,
      });
      continue;
    }
    return { status: res.status, text, json, headers: res.headers, redact };
  }
  throw last || upstream(0, 'Microsoft request failed');
}

// ---- Entra token endpoint ---------------------------------------------------------------

function needIds(c, withSecret) {
  if (!c.tenant) throw new HttpError(400, 'Cowork is not configured: tenant id');
  if (!c.clientId) throw new HttpError(400, 'Cowork is not configured: client id');
  if (withSecret && !c.clientSecret) throw new HttpError(400, 'Cowork is not configured: client secret');
}

function tokenPost(c, path, form) {
  return request(`${c.login}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  }, c);
}

const expiryOf = (json) => clockFn() + Math.max(120, Number(json.expires_in) || 3600) * 1000 - 60000;

/** App-only Graph token (client credentials), cached until shortly before expiry. */
async function appToken() {
  const c = cfg();
  needIds(c, true);
  const sig = `${c.login}|${c.tenant}|${c.clientId}|${c.clientSecret}`;
  if (appCache && appCache.sig === sig && appCache.exp > clockFn()) return appCache.token;
  const r = await tokenPost(c, 'token', {
    grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, scope: APP_SCOPE,
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw upstream(r.status, `Microsoft refused the app sign-in (HTTP ${r.status}): ${r.redact(errorText(r.json, r.text))}`);
  }
  appCache = { sig, token: r.json.access_token, exp: expiryOf(r.json) };
  return appCache.token;
}

function storeRefreshToken(token) {
  settings.set('cowork.refresh_token', token ? secrets.encrypt(token) : '');
  delCache = null;
}

/** Delegated Graph token from the stored refresh token. Returns null when none is stored. */
async function delegatedToken() {
  const c = cfg();
  if (!c.refreshToken) return null;
  needIds(c, false);
  const sig = `${c.login}|${c.tenant}|${c.clientId}|${c.refreshToken}`;
  if (delCache && delCache.sig === sig && delCache.exp > clockFn()) return delCache.token;
  const r = await tokenPost(c, 'token', {
    grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refreshToken, scope: DELEGATED_SCOPE,
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw upstream(r.status, `Microsoft refused the stored administrator sign-in (HTTP ${r.status}): ${r.redact(errorText(r.json, r.text))}. Sign in as administrator again.`);
  }
  let used = c.refreshToken;
  if (r.json.refresh_token && r.json.refresh_token !== c.refreshToken) { storeRefreshToken(r.json.refresh_token); used = r.json.refresh_token; }
  delCache = { sig: `${c.login}|${c.tenant}|${c.clientId}|${used}`, token: r.json.access_token, exp: expiryOf(r.json) };
  return r.json.access_token;
}

/** Start the device code flow. Returns {user_code, verification_uri, device_code, interval, expires_in, message}. */
async function deviceStart() {
  const c = cfg();
  needIds(c, false);
  const r = await tokenPost(c, 'devicecode', { client_id: c.clientId, scope: DELEGATED_SCOPE });
  if (r.status !== 200 || !r.json || !r.json.device_code) {
    throw upstream(r.status, `Microsoft refused the device code request (HTTP ${r.status}): ${r.redact(errorText(r.json, r.text))}. Check that the app registration allows public client flows.`);
  }
  return r.json;
}

/** One poll of the device code grant. Returns {state: 'pending' | 'done' | 'error', ...}. */
async function devicePoll(deviceCode) {
  const c = cfg();
  needIds(c, false);
  const r = await tokenPost(c, 'token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: c.clientId, device_code: deviceCode,
  });
  if (r.status === 200 && r.json && r.json.access_token) return { state: 'done', json: r.json };
  const code = r.json && r.json.error;
  if (code === 'authorization_pending' || code === 'slow_down') return { state: 'pending', slowDown: code === 'slow_down' };
  return { state: 'error', error: code || 'error', detail: r.redact(errorText(r.json, r.text)) };
}

// ---- Graph -------------------------------------------------------------------------------

/** GET a Graph URL (absolute, or a path under graph_base). opts: {token, text, headers}. Throws on non-200. */
async function graphGet(pathOrUrl, opts = {}) {
  const c = cfg();
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : c.graph + pathOrUrl;
  const headers = { accept: opts.text ? 'text/csv, application/json' : 'application/json', authorization: `Bearer ${opts.token}` };
  Object.assign(headers, opts.headers || {});
  const r = await request(url, { method: 'GET', headers }, c);
  if (r.status === 200) return opts.text ? r.text : (r.json || {});
  const msg = r.redact(errorText(r.json, r.text));
  const who = r.status === 401 || r.status === 403 ? 'refused the request' : 'rejected the request';
  throw upstream(r.status, `Microsoft ${who} (HTTP ${r.status}): ${msg}`);
}

/**
 * $batch of GETs. reqs = [{id, url}] with urls relative to the version root ('v1.0' or 'beta').
 * Returns Map id -> {status, body}. Sub-requests answered 429 or 503 are retried after a backoff.
 */
async function batchGet(root, reqs, token) {
  const c = cfg();
  const out = new Map();
  let todo = reqs.slice();
  for (let round = 0; round <= RETRIES && todo.length; round++) {
    if (round > 0) {
      stats.retries += 1;
      await sleepFn(backoffMs * 2 ** (round - 1));
    }
    const next = [];
    for (let i = 0; i < todo.length; i += BATCH_MAX) {
      const chunk = todo.slice(i, i + BATCH_MAX);
      stats.batches += 1;
      const r = await request(`${c.graph}/${root}/$batch`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ requests: chunk.map((q) => ({ id: String(q.id), method: 'GET', url: q.url, headers: { ConsistencyLevel: 'eventual' } })) }),
      }, c);
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.responses)) {
        throw upstream(r.status, `Microsoft rejected the $batch request (HTTP ${r.status}): ${r.redact(errorText(r.json, r.text))}`, { batchFailed: true });
      }
      const seen = new Set();
      for (const x of r.json.responses) {
        seen.add(String(x.id));
        if ((x.status === 429 || x.status === 503) && round < RETRIES) { next.push(chunk.find((q) => String(q.id) === String(x.id))); continue; }
        out.set(String(x.id), { status: x.status, body: x.body });
      }
      for (const q of chunk) if (!seen.has(String(q.id))) out.set(String(q.id), { status: 0, body: null });
    }
    todo = next.filter(Boolean);
  }
  return out;
}

// ---- CSV ---------------------------------------------------------------------------------

/** Parse CSV text (BOM, quotes, CRLF) into [{header: value}]. */
function parseCsv(text) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const endRow = () => { row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; endRow(); }
    else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/** The Copilot usage user detail report (CSV). Tries the /copilot/reports path, then /reports. */
async function copilotUserReport(token, period = 'D30') {
  const fn = `getMicrosoft365CopilotUsageUserDetail(period='${period}')`;
  const paths = [`/v1.0/copilot/reports/${fn}`, `/v1.0/reports/${fn}`];
  let firstErr = null;
  for (const p of paths) {
    try {
      const text = await graphGet(p, { token, text: true });
      return { rows: parseCsv(text), path: p };
    } catch (e) {
      if (e.upstreamStatus === 401) throw e;
      if (!firstErr) firstErr = e;
      else throw upstream(e.upstreamStatus, `${e.message} (the ${paths[0]} path also failed: ${firstErr.message})`);
    }
  }
  throw firstErr;
}

const odataQuote = (s) => String(s).replace(/'/g, "''");

/** Resolve UPNs to Entra users through $batch. Returns Map lower-case upn -> user (missing = not found). */
async function usersByUpn(upns, token) {
  const out = new Map();
  const reqs = upns.map((u, i) => ({
    id: String(i),
    url: `/users?$select=${USER_SELECT}&$filter=${encodeURIComponent(`userPrincipalName eq '${odataQuote(u)}'`)}`,
  }));
  const res = await batchGet('v1.0', reqs, token);
  upns.forEach((u, i) => {
    const r = res.get(String(i));
    if (!r || r.status !== 200 || !r.body) return;
    const first = Array.isArray(r.body.value) ? r.body.value[0] : null;
    if (first) out.set(u.toLowerCase(), first);
  });
  return out;
}

/** All licensed users (users_source all_licensed), paged. */
async function licensedUsers(token) {
  const out = [];
  let url = `/v1.0/users?$select=${USER_SELECT}&$filter=${encodeURIComponent('assignedLicenses/$count ne 0')}&$count=true&$top=999`;
  for (let i = 0; i < 500 && url; i++) {
    const body = await graphGet(url, { token, headers: { ConsistencyLevel: 'eventual' } });
    if (Array.isArray(body.value)) out.push(...body.value);
    url = body['@odata.nextLink'] || null;
  }
  return out;
}

const BAL_URL = (id) => `/copilot/costManagement/userBalances/${encodeURIComponent(id)}?$expand=serviceBalances`;

/**
 * Balances for user ids with the delegated token. Returns Map id -> {status, body}.
 * Uses beta $batch; when the batch endpoint itself is refused it falls back to one call per user.
 */
async function userBalances(ids, delegated) {
  try {
    return await batchGet('beta', ids.map((id) => ({ id, url: BAL_URL(id) })), delegated);
  } catch (e) {
    if (!e.batchFailed || ![400, 404, 405].includes(e.upstreamStatus)) throw e;
  }
  const out = new Map();
  const c = cfg();
  for (const id of ids) {
    const r = await request(`${c.graph}/beta${BAL_URL(id)}`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${delegated}` },
    }, c);
    out.set(String(id), { status: r.status, body: r.json });
  }
  return out;
}

const tenantBalance = (delegated) => graphGet('/beta/copilot/costManagement/getTenantCreditBalance', { token: delegated });
const me = (delegated) => graphGet('/v1.0/me?$select=userPrincipalName,displayName', { token: delegated });

module.exports = {
  DELEGATED_SCOPE, APP_SCOPE, BATCH_MAX, cfg, appToken, delegatedToken, storeRefreshToken, deviceStart, devicePoll,
  graphGet, batchGet, parseCsv, copilotUserReport, usersByUpn, licensedUsers, userBalances, tenantBalance, me,
  setSleep, setClock, setPace, setBackoff, resetPacer, resetStats, resetTokens, now, stats, errorText,
};
