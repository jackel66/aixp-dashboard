'use strict';
// Anthropic Claude Enterprise connector (CONTRACT section 16.2). Built blind: no key existed when this
// was written, so every UNVERIFIED shape is read defensively and the Test connection checklist is the
// fix loop on the first real key.
const settings = require('../settings');
const client = require('./anthropicClient');
const win = require('./window');
const { badRequest } = require('../../errors');

const id = 'anthropic';
const label = 'Anthropic Claude Enterprise';
const platform = 'anthropic';
const HARD_FLOOR = '2026-01-01'; // the API serves nothing before this date
const MAX_DAYS_BACK = 365;
const UNATTRIBUTED = 'anthropic:unattributed';

const enabled = () => !!settings.get('anthropic.enabled', false);
const rebuildDays = () => Number(settings.get('anthropic.rebuild_days', 9)) || 9;

function historyFloor() {
  const s = String(settings.get('anthropic.history_floor', HARD_FLOOR) || HARD_FLOOR);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s > HARD_FLOOR ? s : HARD_FLOOR;
}

function problems() {
  const out = [];
  if (!settings.getSecret('anthropic.api_key')) out.push('api key');
  return out;
}

function describe() {
  return {
    fields: [
      { key: 'anthropic.api_key', label: 'Analytics API key', type: 'secret', hint: 'sk-ant-api01-..., scope read:analytics (read:rbac_groups adds team mapping)' },
      { key: 'anthropic.rebuild_days', label: 'Re-pull days', type: 'number', min: 1, max: 31 },
      { key: 'anthropic.base_url', label: 'Base URL', type: 'text', advanced: true },
      { key: 'anthropic.anthropic_version', label: 'API version header', type: 'text', advanced: true },
    ],
    limits: { requests_per_minute: 60, pace_ms: 1000, max_span_days: 31, max_days_back: MAX_DAYS_BACK, page_size: client.LIMIT },
    lag: 'Typically 4 hours behind, up to 24 hours; values can change until about 7 days after month end.',
    history_floor: historyFloor(),
    help: [
      'The primary owner of the Enterprise organization creates the Analytics key at claude.ai under Organization settings, API.',
      'The key needs the read:analytics scope; read:rbac_groups adds team mapping.',
    ],
  };
}

// ---- merge: cost rows + usage rows -> usage grain, per-product detail, coverage -----------

function personOf(actor) {
  if (actor && typeof actor === 'object') {
    const email = String(actor.email_address || '').trim().toLowerCase();
    if (email) return { key: email, email, attributed: true, byId: false };
    if (actor.user_id) return { key: `user:${String(actor.user_id).trim()}`.toLowerCase(), email: '', attributed: true, byId: true };
  }
  return { key: UNATTRIBUTED, email: '', attributed: false, byId: false };
}

const productOf = (p) => {
  const t = String(p === null || p === undefined ? '' : p).trim().toLowerCase().replace(/-/g, '_');
  return t || 'other';
};
const modelOf = (m) => {
  const t = String(m === null || m === undefined ? '' : m).trim();
  return t || 'unattributed';
};
const dayOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function merge(costRows, usageRows) {
  const byKey = new Map();
  let idKeyed = 0;
  const slot = (row) => {
    const g = (row && row.group) || {};
    const day = dayOf(row.starting_at);
    if (!day) return null;
    const p = personOf(g.actor);
    const model = modelOf(g.model);
    const product = productOf(g.product);
    const k = `${day}|${p.key}|${model}|${product}`;
    let s = byKey.get(k);
    if (!s) {
      s = { day, person: p, model, product, cents: 0, listCents: 0, tokens: 0, requests: 0, reqSeen: false };
      byKey.set(k, s);
      if (p.byId) idKeyed += 1;
    }
    return s;
  };
  for (const r of costRows) {
    const s = slot(r);
    if (!s) continue;
    const c = r.cost || {};
    s.cents += num(c.amount) || 0;
    s.listCents += num(c.list_amount) || 0;
  }
  for (const r of usageRows) {
    const s = slot(r);
    if (!s) continue;
    const u = r.usage || {};
    const t = num(u.total_tokens);
    s.tokens += t !== null ? t : (num(u.uncached_input_tokens) || 0) + (num(u.output_tokens) || 0)
      + (num(u.cache_read_input_tokens) || 0)
      + (num(u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0)
      + (num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
    const q = num(u.requests);
    if (q !== null) { s.requests += q; s.reqSeen = true; }
  }

  const detail = [];
  const grain = new Map();
  let userCents = 0;
  for (const s of byKey.values()) {
    detail.push({
      vendor: id, date: s.day, person_key: s.person.key, email: s.person.email, model: s.model, product: s.product,
      tokens: s.tokens, cost_usd: s.cents / 100, list_cost_usd: s.listCents / 100, requests: s.reqSeen ? s.requests : null,
    });
    if (s.person.attributed) userCents += s.cents;
    const gk = `${s.day}|${s.person.key}|${s.model}`;
    let g = grain.get(gk);
    if (!g) {
      g = { day: s.day, person: s.person, model: s.model, tokens: 0, cents: 0, listCents: 0, requests: 0, reqSeen: false };
      grain.set(gk, g);
    }
    g.tokens += s.tokens; g.cents += s.cents; g.listCents += s.listCents;
    if (s.reqSeen) { g.requests += s.requests; g.reqSeen = true; }
  }
  const usage = [...grain.values()].map((g) => ({
    Date: g.day,
    PersonKey: g.person.key,
    Platform: platform,
    Model: g.model,
    Tokens: g.tokens,
    Credits: '',
    ConsumptionUnit: 'tokens',
    CostUSD: g.cents / 100,
    Requests: g.reqSeen ? g.requests : '',
    ListCostUSD: g.listCents / 100,
    Email: g.person.email,
  }));
  usage.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : a.PersonKey < b.PersonKey ? -1 : a.PersonKey > b.PersonKey ? 1 : a.Model < b.Model ? -1 : 1));
  detail.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.person_key < b.person_key ? -1 : a.person_key > b.person_key ? 1 : a.model + a.product < b.model + b.product ? -1 : 1));
  return { usage, detail, user_rows_usd: userCents / 100, id_keyed: idKeyed };
}

// ---- groups (team mapping) --------------------------------------------------------------

let loggedMember = false;
function memberOf(m) {
  if (!m || typeof m !== 'object') return null;
  const user = m.user && typeof m.user === 'object' ? m.user : {};
  const email = String(m.email_address || m.email || user.email_address || user.email || '').trim().toLowerCase();
  const uid = String(m.user_id || user.id || user.user_id || m.id || '').trim();
  const name = String(m.name || m.display_name || user.name || user.display_name || '').trim();
  if (!email && !uid) return null;
  return { person_key: email || `user:${uid}`.toLowerCase(), email, display_name: name };
}

async function readGroups(log) {
  let groups;
  try {
    groups = await client.listGroups();
  } catch (e) {
    return { values: [], skipped: e.upstreamStatus === 401 || e.upstreamStatus === 403 ? 'read:rbac_groups not granted' : e.message };
  }
  const values = [];
  for (const g of groups) {
    const name = String((g && g.name) || '').trim();
    if (!name || !g.id) continue;
    let members;
    try {
      members = await client.listGroupMembers(g.id);
    } catch (e) {
      log(`group "${name}": members not read (${e.message})`);
      continue;
    }
    if (members.length && !loggedMember && (process.env.AIXP_DEBUG === '1' || process.env.LOG_LEVEL === 'debug')) {
      loggedMember = true;
      log(`debug: first raw rbac member object: ${JSON.stringify(members[0])}`);
    }
    const seen = new Set();
    const people = [];
    for (const m of members) {
      const p = memberOf(m);
      if (p && !seen.has(p.person_key)) { seen.add(p.person_key); people.push(p); }
    }
    values.push({ value: name, people });
  }
  return { values, skipped: null };
}

// ---- pull ---------------------------------------------------------------------------------

async function pull({ from, to, log = () => {}, progress = () => {} }) {
  const miss = problems();
  if (miss.length) throw badRequest(`Anthropic is not configured: ${miss.join(', ')}`);
  progress('auth', { message: 'Reading from the Anthropic Analytics API' });
  const sl = win.slices(from, to);
  const costRows = [];
  const usageRows = [];
  let orgCents = 0;
  let refreshed = null;
  const keepRefreshed = (v) => { if (v && (!refreshed || v > refreshed)) refreshed = v; };
  for (const s of sl) {
    const tag = `${win.toDate(s.startMs)} to ${win.toDate(s.endMs)}`;
    const opts = { bucket: '1d', groupBy: ['actor', 'model', 'product'], actorTypes: ['user_actor'] };
    const c = await client.analytics('cost', s.startMs, s.endMs, opts);
    costRows.push(...c.rows);
    keepRefreshed(c.data_refreshed_at);
    progress('usage', { table: 'cost', chunk: tag, rows: costRows.length, message: `cost ${tag}: ${c.rows.length} rows` });
    const u = await client.analytics('usage', s.startMs, s.endMs, opts);
    usageRows.push(...u.rows);
    keepRefreshed(u.data_refreshed_at);
    progress('usage', { table: 'usage', chunk: tag, rows: usageRows.length, message: `usage ${tag}: ${u.rows.length} rows` });
    const t = await client.orgTotalCents(s.startMs, s.endMs);
    orgCents += t.cents;
    keepRefreshed(t.data_refreshed_at);
  }
  const merged = merge(costRows, usageRows);
  if (merged.id_keyed) log(`${merged.id_keyed} cost rows had no email and are keyed by user id ("user:<id>")`);

  progress('people', { table: 'rbac_groups', rows: 0, message: 'Reading groups' });
  const groups = await readGroups(log);
  if (groups.skipped) log(`groups skipped: ${groups.skipped}`);
  progress('people', { table: 'rbac_groups', rows: groups.values.length, message: groups.skipped ? `Groups skipped: ${groups.skipped}` : `${groups.values.length} groups` });

  return {
    usage: merged.usage,
    detail: merged.detail,
    orgs: { values: groups.values },
    coverage: { org_total_usd: orgCents / 100, user_rows_usd: merged.user_rows_usd, data_refreshed_at: refreshed },
  };
}

// ---- test ---------------------------------------------------------------------------------

async function test() {
  const t0 = Date.now();
  const steps = [];
  const add = (key, ok, lbl, detail) => { steps.push({ key, ok, label: lbl, detail }); return ok; };
  const finish = () => ({ ok: steps.every((s) => s.ok), duration_ms: Date.now() - t0, steps });
  const notChecked = (from, why) => {
    for (const [key, lbl] of from) add(key, false, lbl, `Not checked: ${why}`);
    return finish();
  };
  const ALL = [['cost', 'Cost data'], ['usage', 'Usage data'], ['groups', 'Groups'], ['freshness', 'Freshness'], ['floor', 'History floor']];

  let miss = [];
  try { miss = problems(); } catch (e) { miss = [e.message]; }
  if (miss.length) {
    add('auth', false, 'Analytics key', `Not configured: ${miss.join(', ')}`);
    return notChecked(ALL, 'no key');
  }
  const today = new Date().toISOString().slice(0, 10);
  const dayMs = win.toMs(win.addDays(today, -1));
  const dayEnd = dayMs + win.DAY;
  const opts = { bucket: '1d', groupBy: ['actor', 'model', 'product'], actorTypes: ['user_actor'], limit: 5 };

  let cost = null;
  try {
    cost = await client.analytics('cost', dayMs, dayEnd, opts);
    add('auth', true, 'Analytics key', 'The key was accepted by /v1/organizations/analytics/cost');
  } catch (e) {
    add('auth', false, 'Analytics key', e.message);
    return notChecked(ALL, 'the key was not accepted');
  }
  add('cost', true, 'Cost data', `${cost.rows.length} cost rows for yesterday (UTC); data_refreshed_at ${cost.data_refreshed_at || 'not reported'}`);

  let usage = null;
  try {
    usage = await client.analytics('usage', dayMs, dayEnd, opts);
    add('usage', true, 'Usage data', `${usage.rows.length} usage rows for yesterday (UTC)`);
  } catch (e) {
    add('usage', false, 'Usage data', e.message);
  }

  try {
    const g = await client.listGroups();
    add('groups', true, 'Groups', `${g.length} group${g.length === 1 ? '' : 's'} readable`);
  } catch (e) {
    if (e.upstreamStatus === 401 || e.upstreamStatus === 403) add('groups', true, 'Groups', 'read:rbac_groups not granted, org mapping skipped');
    else add('groups', false, 'Groups', e.message);
  }

  const refreshed = (usage && usage.data_refreshed_at) || cost.data_refreshed_at;
  if (!refreshed) add('freshness', true, 'Freshness', 'data_refreshed_at was not reported');
  else {
    const hours = (Date.now() - Date.parse(refreshed)) / 3600000;
    add('freshness', Number.isFinite(hours) && hours < 24, 'Freshness', `data_refreshed_at ${refreshed} (${Number.isFinite(hours) ? hours.toFixed(1) : '?'} hours ago)`);
  }

  const monthsBack = Number(settings.get('vendors.months_back', 13)) || 13;
  const from = win.planFrom({ floor: historyFloor(), monthsBack, rebuildDays: rebuildDays(), lastDay: null, maxDaysBack: MAX_DAYS_BACK, today });
  add('floor', true, 'History floor', `Data is available from ${historyFloor()}; a first pull covers ${from} to ${today} (UTC)`);
  return finish();
}

module.exports = {
  id, label, platform, describe, problems, enabled, rebuildDays, historyFloor, maxDaysBack: MAX_DAYS_BACK, test, pull,
  merge, personOf, UNATTRIBUTED,
};
