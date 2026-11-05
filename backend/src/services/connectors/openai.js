'use strict';
// OpenAI connector (CONTRACT section 18.4). Two sub-sources, each active when its key is set:
//  A. API platform: organization usage/completions + costs (+ users for user_id -> email). Costs have no model
//     dimension, so per-model dollars are an ALLOCATION by token share (cost_source 'allocated').
//  B. ChatGPT Enterprise: hourly per-user credits and estimated USD at list rate from a compliance costs route.
//     The route and the record shape are UNVERIFIED: the path is a setting and the parser is shape-tolerant.
// Built blind: the Test connection checklist is the fix loop on the first real keys.
const settings = require('../settings');
const client = require('./openaiClient');
const win = require('./window');
const { badRequest } = require('../../errors');

const id = 'openai';
const label = 'OpenAI (API platform and ChatGPT Enterprise)';
const platform = 'openai';
const HARD_FLOOR = '2024-01-01'; // no history depth is documented; this only bounds the first pull
const ENT_DAYS = 30; // ChatGPT Enterprise keeps 30 days of cost logs and cannot backfill
const UNATTRIBUTED = 'openai:unattributed';

const enabled = () => !!settings.get('openai.enabled', false);
const rebuildDays = () => Number(settings.get('openai.rebuild_days', 3)) || 3;
const historyFloor = () => HARD_FLOOR;
const hasApi = () => !!settings.getSecret('openai.admin_key');
const hasEnt = () => !!settings.getSecret('openai.enterprise_key');

function problems() {
  const out = [];
  const api = hasApi();
  const ent = hasEnt();
  if (!api && !ent) out.push('admin key or enterprise key');
  if (ent) {
    const path = String(settings.get('openai.enterprise_costs_path', client.ENT_PATH) || client.ENT_PATH);
    if (path.includes('{org_id}') && !String(settings.get('openai.enterprise_org_id', '') || '').trim()) out.push('enterprise org id');
  }
  return out;
}

function describe() {
  return {
    fields: [
      { key: 'openai.admin_key', label: 'API platform Admin key', type: 'secret', hint: 'Created by an organization owner at platform.openai.com > Settings > Organization > Admin keys. Leave blank to skip the API platform.' },
      { key: 'openai.enterprise_key', label: 'ChatGPT Enterprise Admin key', type: 'secret', hint: 'Workspace Admin key (prefix sk-admin-) with "Compliance logging platform > Costs > Read". Leave blank to skip ChatGPT Enterprise.' },
      { key: 'openai.enterprise_org_id', label: 'ChatGPT Enterprise organization id', type: 'text', placeholder: 'org-...' },
      { key: 'openai.rebuild_days', label: 'Re-pull days', type: 'number', min: 1, max: 31 },
      { key: 'openai.base_url', label: 'API platform base URL', type: 'text', advanced: true },
      { key: 'openai.enterprise_base_url', label: 'ChatGPT Enterprise base URL', type: 'text', advanced: true },
      { key: 'openai.enterprise_costs_path', label: 'ChatGPT Enterprise costs path', type: 'text', advanced: true, hint: 'UNVERIFIED default; the route was not published. {org_id} is replaced by the organization id.' },
      { key: 'openai.enterprise_rate', label: 'USD per credit (reference only)', type: 'text', advanced: true, hint: 'Not used in any row.' },
    ],
    limits: { pace_ms: 500, usage_page_buckets: client.USAGE_LIMIT, costs_page_buckets: client.COSTS_LIMIT, max_span_days: 31, enterprise_retention_days: ENT_DAYS },
    lag: 'API platform: not documented, the current day is incomplete and the trailing days are pulled again. ChatGPT Enterprise: cost logs publish 3 to 5 hours late and are kept 30 days.',
    history_floor: historyFloor(),
    help: [
      'Either key can be set alone; each sub-source runs only when its key is present.',
      'API platform dollars come per user and day, not per model; they are spread over the models a user ran by token share and marked as allocated.',
      'ChatGPT Enterprise credits are kept for 30 days only and cannot be backfilled, so the pull must run at least daily. Its dollars are an estimate at list rate, not a billed amount.',
      'The ChatGPT Enterprise costs path is unverified. If Test connection reports "costs path not found", set the path under Advanced.',
    ],
  };
}

// ---- helpers --------------------------------------------------------------------------------

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const dayOfSec = (s) => new Date(s * 1000).toISOString().slice(0, 10);
const modelOf = (m) => {
  const t = String(m === null || m === undefined ? '' : m).trim();
  return t || 'unattributed';
};

// ---- A. API platform ------------------------------------------------------------------------

function userIndex(users) {
  const map = new Map();
  for (const u of users || []) {
    if (!u || !u.id) continue;
    const nested = u.user && typeof u.user === 'object' ? u.user : {};
    const email = String(u.email || nested.email || '').trim().toLowerCase();
    map.set(String(u.id), email);
  }
  return map;
}

function personOfUser(uid, emails) {
  if (!uid) return { key: UNATTRIBUTED, email: '', attributed: false };
  const email = emails.get(String(uid)) || '';
  if (email) return { key: email, email, attributed: true };
  return { key: `openai:${String(uid)}`.toLowerCase(), email: '', attributed: true };
}

/**
 * Join completions usage buckets and cost buckets into usage-grain rows plus detail rows.
 * usageBuckets/costBuckets are the API `data` arrays. perUserCosts false = costs were grouped by line_item, so
 * the whole day cost goes to the unattributed key as an exact (not allocated) figure.
 */
function mergeApi(usageBuckets, costBuckets, emails, perUserCosts, onSkip) {
  const use = new Map(); // day|uid|model -> {tokens, req}
  for (const b of usageBuckets) {
    const day = dayOfSec(Number(b.start_time));
    for (const r of (b && b.results) || []) {
      const uid = r.user_id ? String(r.user_id) : '';
      const model = modelOf(r.model);
      const k = `${day}|${uid}|${model}`;
      const s = use.get(k) || { day, uid, model, tokens: 0, req: 0, reqSeen: false };
      s.tokens += (num(r.input_tokens) || 0) + (num(r.output_tokens) || 0);
      const q = num(r.num_model_requests);
      if (q !== null) { s.req += q; s.reqSeen = true; }
      use.set(k, s);
    }
  }
  const cost = new Map(); // day|uid -> usd
  let nonUsd = 0;
  let orgUsd = 0;
  for (const b of costBuckets) {
    const day = dayOfSec(Number(b.start_time));
    for (const r of (b && b.results) || []) {
      const a = r.amount || {};
      const cur = String(a.currency || 'usd').toLowerCase();
      const v = num(a.value);
      if (v === null) continue;
      if (cur !== 'usd') { nonUsd += 1; continue; }
      const uid = perUserCosts && r.user_id ? String(r.user_id) : '';
      const k = `${day}|${uid}`;
      cost.set(k, (cost.get(k) || 0) + v);
      orgUsd += v;
    }
  }
  if (nonUsd && onSkip) onSkip(`${nonUsd} cost rows were not in USD and were skipped`);

  const byUser = new Map(); // day|uid -> [usage entries]
  for (const s of use.values()) {
    const k = `${s.day}|${s.uid}`;
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(s);
  }
  const usage = [];
  const detail = [];
  let userUsd = 0;
  const push = (day, uid, model, tokens, req, reqSeen, usd, source) => {
    const p = personOfUser(uid, emails);
    usage.push({
      Date: day, PersonKey: p.key, Platform: platform, Model: model, Tokens: tokens, Credits: '', ConsumptionUnit: 'tokens',
      CostUSD: usd === null ? '' : usd, Requests: reqSeen ? req : '', CostSource: usd === null ? '' : source, Email: p.email,
    });
    detail.push({
      vendor: id, date: day, person_key: p.key, email: p.email, model, product: 'api', tokens,
      cost_usd: usd === null ? 0 : usd, list_cost_usd: null, requests: reqSeen ? req : null,
    });
    if (p.attributed && usd !== null && perUserCosts) userUsd += usd;
  };
  const keys = new Set([...byUser.keys(), ...cost.keys()]);
  for (const k of keys) {
    const [day, uid] = k.split('|');
    const list = byUser.get(k) || [];
    const total = cost.has(k) ? cost.get(k) : null;
    list.sort((a, b) => (a.model < b.model ? -1 : 1));
    if (list.length === 0) {
      push(day, uid, 'unattributed', 0, 0, false, total, 'vendor');
      continue;
    }
    if (total === null || !perUserCosts && uid === '') {
      // No cost for this user-day, or the whole-organization cost is carried on its own row below.
      for (const s of list) push(day, uid, s.model, s.tokens, s.req, s.reqSeen, null, 'allocated');
      if (total !== null && !perUserCosts && uid === '') push(day, uid, 'unattributed', 0, 0, false, total, 'vendor');
      continue;
    }
    const tokTotal = list.reduce((a, s) => a + s.tokens, 0);
    let left = total;
    list.forEach((s, i) => {
      const share = i === list.length - 1 ? left : total * (tokTotal > 0 ? s.tokens / tokTotal : 1 / list.length);
      left -= share;
      push(day, uid, s.model, s.tokens, s.req, s.reqSeen, share, 'allocated');
    });
  }
  return { usage, detail, org_usd: orgUsd, user_usd: userUsd };
}

async function pullApi(from, to, log, progress) {
  const sl = win.slices(from, to);
  const usageBuckets = [];
  const costBuckets = [];
  let perUser = true;
  for (const s of sl) {
    const tag = `${win.toDate(s.startMs)} to ${win.toDate(s.endMs)}`;
    const u = await client.usageCompletions(s.startMs, s.endMs, { groupBy: ['user_id', 'model'] });
    usageBuckets.push(...u);
    progress('usage', { table: 'usage', chunk: tag, rows: usageBuckets.length, message: `api usage ${tag}: ${u.length} buckets` });
    let c;
    if (perUser) {
      try {
        c = await client.costs(s.startMs, s.endMs, { groupBy: ['user_id'] });
      } catch (e) {
        if (e.upstreamStatus !== 400) throw e;
        perUser = false;
        log(`costs are not attributable per user on this organization (group_by user_id refused: ${e.detail || e.message})`);
      }
    }
    if (!perUser) c = await client.costs(s.startMs, s.endMs, { groupBy: ['line_item'] });
    costBuckets.push(...c);
    progress('usage', { table: 'costs', chunk: tag, rows: costBuckets.length, message: `api costs ${tag}: ${c.length} buckets` });
  }
  // user_id -> email, only when there is someone to resolve
  let emails = new Map();
  const needs = usageBuckets.some((b) => ((b && b.results) || []).some((r) => r.user_id))
    || costBuckets.some((b) => ((b && b.results) || []).some((r) => r.user_id));
  if (needs) {
    progress('people', { table: 'users', rows: 0, message: 'Reading organization users' });
    try {
      emails = userIndex(await client.listUsers());
      progress('people', { table: 'users', rows: emails.size, message: `${emails.size} organization users` });
    } catch (e) {
      log(`users not read (${e.message}); rows are keyed by user id`);
    }
  }
  const merged = mergeApi(usageBuckets, costBuckets, emails, perUser, log);
  if (!perUser) merged.note = 'costs are not attributable per user on this organization';
  return merged;
}

// ---- B. ChatGPT Enterprise ------------------------------------------------------------------

const FIELD_NAMES = {
  email: ['user_email', 'email', 'user.email', 'actor.email'],
  time: ['timestamp', 'start_time', 'hour', 'created_at', 'date'],
  model: ['model'],
  total_tokens: ['total_tokens'],
  input_tokens: ['input_tokens'],
  output_tokens: ['output_tokens'],
  credits: ['billing_cost_value', 'credits', 'cost_credits', 'credit_amount'],
  usd: ['billing_estimated_cost_usd_value', 'estimated_cost_usd', 'cost_usd', 'amount.value'],
  user_id: ['user_id', 'actor.id', 'user.id'],
};

function flatten(obj, prefix, out) {
  out = out || {};
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj) || typeof obj !== 'object') {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

// First candidate (in order) that has a non-empty value; match is the whole flattened path or its tail.
function pick(flat, names) {
  const keys = Object.keys(flat);
  for (const n of names) {
    const want = n.toLowerCase();
    for (const k of keys) {
      const lk = k.toLowerCase();
      if ((lk === want || lk.endsWith(`.${want}`)) && flat[k] !== null && flat[k] !== undefined && flat[k] !== '') {
        return { path: k, value: flat[k] };
      }
    }
  }
  return null;
}

function toUtcDay(v) {
  if (v === null || v === undefined || v === '') return null;
  let ms;
  const n = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : null);
  if (n !== null) ms = n < 1e12 ? n * 1000 : n;
  else ms = Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// Which paths of one record map to which app column. Key names only, never values.
function describeShape(record) {
  const flat = flatten(record);
  const mapped = {};
  for (const [col, names] of Object.entries(FIELD_NAMES)) {
    const hit = pick(flat, names);
    if (hit) mapped[col] = hit.path;
  }
  return { keys: Object.keys(flat), mapped };
}

/** Roll raw Enterprise records to UTC days per email and model. Returns {usage, detail, ...counters}. */
function parseEnterprise(records, fromDay, toDay) {
  const agg = new Map();
  let skipped = 0;
  let outside = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') { skipped += 1; continue; }
    const flat = flatten(rec);
    const t = pick(flat, FIELD_NAMES.time);
    const day = t ? toUtcDay(t.value) : null;
    if (!day) { skipped += 1; continue; }
    if (day < fromDay || day > toDay) { outside += 1; continue; }
    const e = pick(flat, FIELD_NAMES.email);
    const email = e ? String(e.value).trim().toLowerCase() : '';
    const uidHit = email ? null : pick(flat, FIELD_NAMES.user_id);
    const key = email || (uidHit ? `openai:${String(uidHit.value).trim()}`.toLowerCase() : UNATTRIBUTED);
    const model = modelOf((pick(flat, FIELD_NAMES.model) || {}).value);
    const tt = pick(flat, FIELD_NAMES.total_tokens);
    let tokens;
    if (tt && num(tt.value) !== null) tokens = num(tt.value);
    else tokens = (num((pick(flat, FIELD_NAMES.input_tokens) || {}).value) || 0) + (num((pick(flat, FIELD_NAMES.output_tokens) || {}).value) || 0);
    const cr = pick(flat, FIELD_NAMES.credits);
    const us = pick(flat, FIELD_NAMES.usd);
    const k = `${day}|${key}|${model}`;
    const a = agg.get(k) || { day, key, email, model, tokens: 0, credits: 0, usd: 0, usdSeen: false, creditsSeen: false };
    a.tokens += tokens;
    if (cr && num(cr.value) !== null) { a.credits += num(cr.value); a.creditsSeen = true; }
    if (us && num(us.value) !== null) { a.usd += num(us.value); a.usdSeen = true; }
    agg.set(k, a);
  }
  const usage = [];
  const detail = [];
  let orgUsd = 0;
  let userUsd = 0;
  for (const a of agg.values()) {
    usage.push({
      Date: a.day, PersonKey: a.key, Platform: platform, Model: a.model, Tokens: a.tokens, Credits: a.creditsSeen ? a.credits : '',
      ConsumptionUnit: 'tokens', CostUSD: a.usdSeen ? a.usd : '', Requests: '', CostSource: a.usdSeen ? 'vendor' : '', Email: a.email,
    });
    detail.push({
      vendor: id, date: a.day, person_key: a.key, email: a.email, model: a.model, product: 'chatgpt_enterprise',
      tokens: a.tokens, cost_usd: a.usdSeen ? a.usd : 0, list_cost_usd: a.usdSeen ? a.usd : null, requests: null,
    });
    if (a.usdSeen) { orgUsd += a.usd; if (a.key !== UNATTRIBUTED) userUsd += a.usd; }
  }
  return { usage, detail, org_usd: orgUsd, user_usd: userUsd, skipped, outside };
}

const entAfter = (from, today) => {
  const floor = win.addDays(today, -ENT_DAYS);
  const day = win.maxDate(from, floor);
  return `${day}T00:00:00Z`;
};

async function pullEnterprise(from, to, log, progress) {
  const today = to.slice(0, 10);
  const afterIso = entAfter(from, today);
  progress('usage', { table: 'enterprise', rows: 0, message: `ChatGPT Enterprise costs from ${afterIso.slice(0, 10)}` });
  const r = await client.enterpriseCosts(afterIso, {
    onPage: (n) => progress('usage', { table: 'enterprise', rows: n, message: `ChatGPT Enterprise: ${n} records` }),
  });
  if (r.rows.length) {
    const shape = describeShape(r.rows[0]);
    log(`enterprise costs ${r.rows.length} records over ${r.pages} pages; first record keys: ${shape.keys.join(', ')}; mapped: ${JSON.stringify(shape.mapped)}`);
  } else log('enterprise costs returned no records');
  const parsed = parseEnterprise(r.rows, afterIso.slice(0, 10), today);
  if (parsed.skipped) log(`enterprise: ${parsed.skipped} records had no readable timestamp and were skipped`);
  return parsed;
}

// ---- combine --------------------------------------------------------------------------------

// The usage grain is (Date, PersonKey, Platform, Model): rows from both sub-sources that land on the same key
// are summed and the cost source reads 'allocated+vendor'. The detail table keeps them apart by product.
function combine(parts) {
  const grain = new Map();
  for (const row of parts) {
    const k = `${row.Date}|${row.PersonKey}|${row.Model}`;
    const g = grain.get(k);
    if (!g) { grain.set(k, Object.assign({}, row)); continue; }
    g.Tokens += Number(row.Tokens) || 0;
    if (row.Credits !== '') g.Credits = (g.Credits === '' ? 0 : Number(g.Credits)) + Number(row.Credits);
    if (row.CostUSD !== '') g.CostUSD = (g.CostUSD === '' ? 0 : Number(g.CostUSD)) + Number(row.CostUSD);
    if (row.Requests !== '') g.Requests = (g.Requests === '' ? 0 : Number(g.Requests)) + Number(row.Requests);
    if (row.CostSource && g.CostSource !== row.CostSource) g.CostSource = g.CostSource ? 'allocated+vendor' : row.CostSource;
    if (!g.Email && row.Email) g.Email = row.Email;
  }
  const out = [...grain.values()];
  out.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : a.PersonKey < b.PersonKey ? -1 : a.PersonKey > b.PersonKey ? 1 : a.Model < b.Model ? -1 : a.Model > b.Model ? 1 : 0));
  return out;
}

// ---- pull -----------------------------------------------------------------------------------

async function pull({ from, to, log = () => {}, progress = () => {} }) {
  const miss = problems();
  if (miss.length) throw badRequest(`OpenAI is not configured: ${miss.join(', ')}`);
  progress('auth', { message: 'Reading from OpenAI' });
  const usage = [];
  const detail = [];
  let orgUsd = 0;
  let userUsd = 0;
  const api = hasApi();
  const ent = hasEnt();
  if (api) {
    const a = await pullApi(from, to, log, progress);
    usage.push(...a.usage); detail.push(...a.detail); orgUsd += a.org_usd; userUsd += a.user_usd;
  }
  if (ent) {
    const e = await pullEnterprise(from, to, log, progress);
    usage.push(...e.usage); detail.push(...e.detail); orgUsd += e.org_usd; userUsd += e.user_usd;
  }
  detail.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.person_key < b.person_key ? -1 : a.person_key > b.person_key ? 1 : a.model + a.product < b.model + b.product ? -1 : 1));
  return {
    usage: combine(usage),
    detail,
    orgs: { values: [] },
    coverage: { org_total_usd: orgUsd, user_rows_usd: userUsd, data_refreshed_at: null },
  };
}

// ---- test -----------------------------------------------------------------------------------

async function test() {
  const t0 = Date.now();
  const steps = [];
  const add = (key, ok, lbl, detail) => { steps.push({ key, ok, label: lbl, detail }); return ok; };
  const finish = () => ({ ok: steps.every((s) => s.ok), duration_ms: Date.now() - t0, steps });
  const notChecked = (list, why) => { for (const [key, lbl] of list) add(key, false, lbl, `Not checked: ${why}`); };
  const API = [['api_auth', 'API platform key'], ['usage', 'Usage data'], ['costs', 'Cost data']];
  const ENT = [['ent_auth', 'ChatGPT Enterprise key'], ['ent_shape', 'ChatGPT Enterprise record shape']];

  let miss = [];
  try { miss = problems(); } catch (e) { miss = [e.message]; }
  const api = hasApi();
  const ent = hasEnt();
  if (!api && !ent) {
    add('api_auth', false, 'API platform key', `Not configured: ${miss.join(', ')}`);
    notChecked(API.slice(1).concat(ENT), 'no key');
    return finish();
  }

  const today = new Date().toISOString().slice(0, 10);
  const dayMs = win.toMs(win.addDays(today, -1));
  const dayEnd = dayMs + win.DAY;

  if (!api) {
    for (const [key, lbl] of API) add(key, true, lbl, 'Not configured, skipped');
  } else {
    let ok = false;
    try {
      const users = await client.listUsers({ limit: 1, firstPageOnly: true });
      add('api_auth', true, 'API platform key', `The key was accepted by /v1/organization/users (${users.length} user${users.length === 1 ? '' : 's'} on the first page)`);
      ok = true;
    } catch (e) {
      add('api_auth', false, 'API platform key', e.message);
    }
    if (!ok) notChecked(API.slice(1), 'the key was not accepted');
    else {
      try {
        const u = await client.usageCompletions(dayMs, dayEnd, { groupBy: ['user_id', 'model'], limit: 2, firstPageOnly: true });
        const n = u.reduce((a, b) => a + (((b && b.results) || []).length), 0);
        add('usage', true, 'Usage data', `${n} usage rows on the first page for yesterday (UTC)`);
      } catch (e) {
        add('usage', false, 'Usage data', e.message);
      }
      try {
        const c = await client.costs(dayMs, dayEnd, { groupBy: ['user_id'], limit: 2, firstPageOnly: true });
        const n = c.reduce((a, b) => a + (((b && b.results) || []).length), 0);
        add('costs', true, 'Cost data', `${n} cost rows for yesterday (UTC); group_by user_id was accepted`);
      } catch (e) {
        if (e.upstreamStatus === 400) {
          try {
            const c = await client.costs(dayMs, dayEnd, { groupBy: ['line_item'], limit: 2, firstPageOnly: true });
            const n = c.reduce((a, b) => a + (((b && b.results) || []).length), 0);
            add('costs', true, 'Cost data', `${n} cost rows for yesterday (UTC) grouped by line_item; group_by user_id was refused (${e.detail || e.message}), so costs are not attributable per user on this organization`);
          } catch (e2) {
            add('costs', false, 'Cost data', e2.message);
          }
        } else add('costs', false, 'Cost data', e.message);
      }
    }
  }

  if (!ent) {
    for (const [key, lbl] of ENT) add(key, true, lbl, 'Not configured, skipped');
  } else {
    let r = null;
    if (miss.includes('enterprise org id')) {
      add('ent_auth', false, 'ChatGPT Enterprise key', 'Not configured: enterprise org id');
    } else {
      try {
        r = await client.enterpriseCosts(`${win.addDays(today, -1)}T00:00:00Z`, { limit: 5, firstPageOnly: true });
        add('ent_auth', true, 'ChatGPT Enterprise key', `The costs route answered (${r.rows.length} records on the first page)`);
      } catch (e) {
        if (e.upstreamStatus === 404) add('ent_auth', false, 'ChatGPT Enterprise key', 'costs path not found, set openai.enterprise_costs_path');
        else add('ent_auth', false, 'ChatGPT Enterprise key', e.message);
      }
    }
    if (!r) add('ent_shape', false, 'ChatGPT Enterprise record shape', 'Not checked: the costs route did not answer');
    else if (!r.rows.length) add('ent_shape', true, 'ChatGPT Enterprise record shape', 'No records for the last day, shape not checked');
    else {
      const shape = describeShape(r.rows[0]);
      const m = shape.mapped;
      const ok = !!m.time && !!(m.credits || m.usd);
      const mapped = Object.entries(m).map(([c, p]) => `${c} <- ${p}`).join('; ') || 'nothing';
      add('ent_shape', ok, 'ChatGPT Enterprise record shape',
        `First record keys: ${shape.keys.join(', ')}. Mapped: ${mapped}.${ok ? '' : ' A timestamp and credits or USD are needed.'}`);
    }
  }
  return finish();
}

module.exports = {
  id, label, platform, describe, problems, enabled, rebuildDays, historyFloor, maxDaysBack: null, test, pull,
  mergeApi, parseEnterprise, describeShape, combine, userIndex, UNATTRIBUTED,
};
