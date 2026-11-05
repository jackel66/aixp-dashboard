'use strict';
// GitHub Copilot connector (CONTRACT section 18.3). Built blind: no token existed when this was written,
// so every UNVERIFIED shape is read defensively and the Test connection checklist is the fix loop on the
// first real token. Credits per user per day come from the Copilot metrics users-1-day report; dollars come
// from the billing usage endpoints, allocated across the day's users by credit share (default) or read per
// user from the premium request usage endpoint (dollars_mode per_user).
const settings = require('../settings');
const client = require('./githubClient');
const win = require('./window');
const time = require('../time');
const { badRequest } = require('../../errors');

const id = 'github';
const label = 'GitHub Copilot';
const platform = 'github';
const HARD_FLOOR = '2025-10-10'; // the metrics reports start here
const MAX_DAYS_BACK = 365;
const LAG_DAYS = 2;
const UNATTRIBUTED = 'github:unattributed';
const TEAM_CAP = 200;

const enabled = () => !!settings.get('github.enabled', false);
const rebuildDays = () => Number(settings.get('github.rebuild_days', 3)) || 3;
const historyFloor = () => HARD_FLOOR;
const enterprise = () => String(settings.get('github.enterprise', '') || '').trim();
const orgList = () => String(settings.get('github.orgs', '') || '').split(/[\s,;]+/).filter(Boolean);
const dollarsMode = () => (settings.get('github.dollars_mode', 'allocate') === 'per_user' ? 'per_user' : 'allocate');
const mapTeams = () => settings.get('github.map_teams', true) !== false;
const callsPerHour = () => Number(settings.get('github.calls_per_hour', 4000)) || 4000;

function problems() {
  const out = [];
  if (!settings.getSecret('github.token')) out.push('token');
  if (!enterprise()) out.push('enterprise');
  return out;
}

function describe() {
  return {
    fields: [
      { key: 'github.token', label: 'Access token', type: 'secret', required: true, hint: 'Fine-grained personal access token or GitHub App installation token with enterprise billing read and Copilot metrics read' },
      { key: 'github.enterprise', label: 'Enterprise slug', type: 'text', required: true, placeholder: 'my-enterprise', hint: 'The enterprise name in github.com/enterprises/<slug>' },
      { key: 'github.orgs', label: 'Organizations', type: 'textarea', placeholder: 'org-one, org-two', hint: 'Comma or space separated logins. Used for seats, teams and cost-center billing; blank skips them' },
      { key: 'github.dollars_mode', label: 'Dollars per user', type: 'select', options: [{ value: 'allocate', label: 'Allocate the daily billing total by AI credits' }, { value: 'per_user', label: 'Read premium request usage per user (many calls)' }] },
      { key: 'github.map_teams', label: 'Map GitHub teams to lines of business', type: 'boolean' },
      { key: 'github.rebuild_days', label: 'Re-pull days', type: 'number', min: 1, max: 31 },
      { key: 'github.calls_per_hour', label: 'API calls per hour budget', type: 'number', min: 500, max: 14000, advanced: true, hint: 'Per-user dollars stop when this many calls were made in one pull' },
      { key: 'github.base_url', label: 'Base URL', type: 'text', advanced: true },
    ],
    limits: {
      requests_per_hour: 5000, per_page: client.PER_PAGE, max_days_back: MAX_DAYS_BACK, lag_days: LAG_DAYS, team_cap: TEAM_CAP,
      note: 'Rate limit 5,000 requests an hour on a personal token, 15,000 on a GitHub App owned by an enterprise organization.',
    },
    lag: 'Usage metrics reports are available two full UTC days after a day closes; billing usage may lag further. The last 3 days are pulled again each run.',
    history_floor: historyFloor(),
    window_align: dollarsMode() === 'per_user' ? 'month' : null,
    help: [
      'Credits per user per day come from the Copilot usage metrics report; the report needs the Copilot usage metrics policy set to Enabled everywhere.',
      'Dollars come from the enterprise billing usage endpoint. The default spreads each day\'s Copilot total across that day\'s users by AI credit share; per-user mode reads premium request usage per user instead and uses many more calls.',
      'The GitHub login is matched to People by user id, then by the email local part. A trailing _capgroup is removed from the login.',
    ],
  };
}

// ---- small helpers --------------------------------------------------------------------------

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Login as the rest of the app sees it: lowercase, trimmed, EMU suffix removed.
function normLogin(raw) {
  return String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase().replace(/_capgroup$/, '');
}

const dayOf = (iso) => String(iso).slice(0, 10);
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const debugOn = () => process.env.AIXP_DEBUG === '1' || process.env.LOG_LEVEL === 'debug';
let loggedRecord = false;

function nextMonth(d) {
  const [y, m] = d.split('-').map(Number);
  return win.toDate(Date.UTC(y, m, 1));
}

function ymd(d) {
  const [y, m, day] = d.split('-').map(Number);
  return { year: y, month: m, day };
}

const entPath = (tail) => `/enterprises/${encodeURIComponent(enterprise())}${tail}`;

// ---- metrics (credits per user per day) -----------------------------------------------------

async function readMetricsDay(day, log) {
  let body;
  try {
    body = await client.get(entPath('/copilot/metrics/reports/users-1-day'), [['day', day]]);
  } catch (e) {
    if (e.notFound) return { ready: false };
    throw e;
  }
  const links = Array.isArray(body.download_links) ? body.download_links : [];
  const byLogin = new Map();
  let bad = 0;
  for (const url of links) {
    const r = await client.ndjson(url);
    bad += r.bad;
    for (const rec of r.rows) {
      if (!loggedRecord && debugOn()) {
        loggedRecord = true;
        log(`debug: first raw users-1-day record keys: ${Object.keys(rec).join(', ')}`);
      }
      const login = normLogin(rec.user_login || rec.login);
      if (!login) continue;
      let u = byLogin.get(login);
      if (!u) { u = { login, credits: 0, creditsSeen: false, interactions: 0, interSeen: false, features: new Map() }; byLogin.set(login, u); }
      const c = num(rec.ai_credits_used);
      if (c !== null) { u.credits += c; u.creditsSeen = true; }
      const q = num(rec.user_initiated_interaction_count);
      if (q !== null) { u.interactions += q; u.interSeen = true; }
      const items = Array.isArray(rec.totals_by_model_feature) ? rec.totals_by_model_feature : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const model = String(it.model || '').trim();
        const feature = String(it.feature || '').trim() || 'chat';
        const k = `${model}|${feature}`;
        const n = num(it.user_initiated_interaction_count !== undefined ? it.user_initiated_interaction_count : it.interaction_count);
        const f = u.features.get(k) || { model, feature, requests: 0, seen: false };
        if (n !== null) { f.requests += n; f.seen = true; }
        u.features.set(k, f);
      }
    }
  }
  if (bad) log(`${day}: ${bad} report lines were not JSON and were skipped`);
  return { ready: true, users: [...byLogin.values()] };
}

// ---- billing (dollars per day) --------------------------------------------------------------

const isCopilot = (it) => String((it && it.product) || '').toLowerCase().includes('copilot');
const itemKey = (it) => [it.date, it.product, it.sku, it.organizationName, it.repositoryName, it.quantity, it.grossAmount, it.discountAmount, it.netAmount].join('|');

// Copilot billing items for one day: the enterprise call plus one call per listed organization, merged
// without repeating an item both calls returned.
async function readBillingDay(day, log, state) {
  const { year, month, day: dd } = ymd(day);
  const params = [['year', year], ['month', month], ['day', dd]];
  const seen = new Set();
  const items = [];
  const take = (list) => {
    for (const it of list) {
      if (!it || typeof it !== 'object' || !isCopilot(it)) continue;
      const k = itemKey(it);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  };
  const sources = [entPath('/settings/billing/usage')].concat(orgList().map((o) => `/organizations/${encodeURIComponent(o)}/settings/billing/usage`));
  for (const path of sources) {
    try {
      const body = await client.get(path, params);
      take(Array.isArray(body.usageItems) ? body.usageItems : []);
    } catch (e) {
      if (e.notFound) {
        if (!state.billing404.has(path)) { state.billing404.add(path); log(`billing usage not available at ${path} (HTTP 404); treated as no dollars`); }
        continue;
      }
      throw e;
    }
  }
  let gross = 0; let disc = 0; let net = 0;
  for (const it of items) { gross += num(it.grossAmount) || 0; disc += num(it.discountAmount) || 0; net += num(it.netAmount) || 0; }
  return { items, gross, disc, net };
}

// ---- pull -----------------------------------------------------------------------------------

function windowDays(from, to) {
  const today = time.now().toISOString().slice(0, 10);
  const cap = win.addDays(today, -LAG_DAYS);
  let last = dayOf(to);
  if (last > cap) last = cap;
  const days = [];
  for (let d = from; d <= last; d = win.addDays(d, 1)) days.push(d);
  return days;
}

async function readTeams(log, progress) {
  const values = [];
  const out = { values, seats: null, seatsByOrg: {}, skipped: [] };
  for (const org of orgList()) {
    if (mapTeams()) {
      try {
        const teams = await client.paged(`/orgs/${encodeURIComponent(org)}/teams`, null, null, { max: TEAM_CAP });
        for (const t of teams) {
          if (!t || !t.slug) continue;
          const name = String(t.name || t.slug).trim();
          let members;
          try {
            members = await client.paged(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(t.slug)}/members`, null, null);
          } catch (e) {
            log(`team ${org}/${name}: members not read (${e.message})`);
            continue;
          }
          const seen = new Set();
          const people = [];
          for (const m of members) {
            const login = normLogin(m && m.login);
            if (login && !seen.has(login)) { seen.add(login); people.push({ person_key: login, email: '', display_name: login }); }
          }
          values.push({ value: `${org}/${name}`, people });
        }
      } catch (e) {
        out.skipped.push(`${org} teams: ${e.message}`);
        log(`teams skipped for ${org}: ${e.message}`);
      }
    }
    try {
      const seats = await client.paged(`/orgs/${encodeURIComponent(org)}/copilot/billing/seats`, null, 'seats');
      out.seatsByOrg[org] = seats.length;
      out.seats = (out.seats || 0) + seats.length;
    } catch (e) {
      out.skipped.push(`${org} seats: ${e.message}`);
      log(`seats skipped for ${org}: ${e.message}`);
    }
  }
  progress('people', { table: 'teams', rows: values.length, message: `${values.length} team groups` });
  return out;
}

async function pull({ from, to, log = () => {}, progress = () => {} }) {
  const miss = problems();
  if (miss.length) throw badRequest(`GitHub is not configured: ${miss.join(', ')}`);
  progress('auth', { message: 'Reading from the GitHub Copilot metrics and billing APIs' });
  const startCalls = client.stats.calls;
  const days = windowDays(from, to);
  const state = { billing404: new Set() };
  const usage = [];
  const detail = [];
  const logins = new Set();
  let orgGross = 0;
  let lastReady = null;
  let stoppedAt = null;

  for (const day of days) {
    const m = await readMetricsDay(day, log);
    if (!m.ready) { stoppedAt = day; log(`metrics report for ${day} is not ready yet (HTTP 404); the window stops before it`); break; }
    lastReady = day;
    const bill = await readBillingDay(day, log, state);
    const hasBill = bill.items.length > 0;
    orgGross += bill.gross;
    const totalCredits = m.users.reduce((a, u) => a + u.credits, 0);
    progress('usage', { table: 'metrics', chunk: day, rows: usage.length, message: `${day}: ${m.users.length} users, ${bill.items.length} billing items` });

    for (const u of m.users) {
      logins.add(u.login);
      const share = hasBill && totalCredits > 0 ? u.credits / totalCredits : null;
      const row = {
        Date: day, PersonKey: u.login, Platform: platform, Model: '',
        Credits: u.creditsSeen ? u.credits : '', ConsumptionUnit: 'credits', Requests: u.interSeen ? u.interactions : '',
        CostUSD: '', discount_amount: '', net_amount: '', Email: '', CostSource: '',
      };
      if (share !== null) {
        row.CostUSD = bill.gross * share;
        row.discount_amount = bill.disc * share;
        row.net_amount = bill.net * share;
        row.CostSource = 'allocated';
      }
      usage.push(row);
      for (const f of u.features.values()) {
        detail.push({
          vendor: id, date: day, person_key: u.login, email: '', model: f.model, product: f.feature,
          tokens: null, cost_usd: null, list_cost_usd: null, requests: f.seen ? f.requests : null,
        });
      }
      detail.push({
        vendor: id, date: day, person_key: u.login, email: '', model: '', product: 'all',
        tokens: u.creditsSeen ? u.credits : null, cost_usd: share !== null ? bill.gross * share : null, list_cost_usd: null,
        requests: u.interSeen ? u.interactions : null,
      });
    }
    if (hasBill && !(totalCredits > 0)) {
      usage.push({
        Date: day, PersonKey: UNATTRIBUTED, Platform: platform, Model: '', Credits: '', ConsumptionUnit: 'credits', Requests: '',
        CostUSD: bill.gross, discount_amount: bill.disc, net_amount: bill.net, Email: '', CostSource: 'allocated',
      });
    }
  }

  // Per-user dollars: one call per login and month, budgeted against github.calls_per_hour.
  if (dollarsMode() === 'per_user' && lastReady) {
    const months = [];
    for (let d = monthStart(from); d <= lastReady; d = nextMonth(d)) months.push(d);
    const limit = callsPerHour();
    let exhausted = false;
    let done = 0;
    const byRow = new Map(usage.map((r) => [`${r.Date}|${r.PersonKey}`, r]));
    outer:
    for (const login of [...logins].sort()) {
      for (const ms of months) {
        if (client.stats.calls - startCalls >= limit) { exhausted = true; break outer; }
        const { year, month } = ymd(ms);
        let body;
        try {
          body = await client.get(entPath('/settings/billing/premium_request/usage'), [['user', login], ['year', year], ['month', month]]);
        } catch (e) {
          if (e.notFound) { log(`per-user usage for ${login} ${ms.slice(0, 7)}: HTTP 404, left allocated`); continue; }
          throw e;
        }
        done += 1;
        const items = (Array.isArray(body.usageItems) ? body.usageItems : []).filter((it) => it && typeof it === 'object');
        if (!items.length) continue;
        // Daily allocated cost for this login and month is replaced by the vendor's own figures.
        for (const r of usage) {
          if (r.PersonKey === login && r.CostSource === 'allocated' && r.Date.slice(0, 7) === ms.slice(0, 7)) {
            r.CostUSD = ''; r.discount_amount = ''; r.net_amount = ''; r.CostSource = '';
          }
        }
        for (let k = detail.length - 1; k >= 0; k--) {
          const d = detail[k];
          if (d.person_key === login && d.product === 'all' && d.date.slice(0, 7) === ms.slice(0, 7)) d.cost_usd = null;
        }
        const date = ms < from ? from : ms;
        let g = 0; let dsc = 0; let n = 0;
        for (const it of items) {
          g += num(it.grossAmount) || 0; dsc += num(it.discountAmount) || 0; n += num(it.netAmount) || 0;
          detail.push({
            vendor: id, date, person_key: login, email: '', model: String(it.model || '').trim(), product: 'premium_request',
            tokens: null, cost_usd: num(it.grossAmount), list_cost_usd: null, requests: num(it.grossQuantity) === null ? null : Math.round(num(it.grossQuantity)),
          });
        }
        const slot = byRow.get(`${date}|${login}`);
        if (slot) {
          slot.CostUSD = g; slot.discount_amount = dsc; slot.net_amount = n; slot.CostSource = 'vendor';
        } else {
          const row = {
            Date: date, PersonKey: login, Platform: platform, Model: '', Credits: '', ConsumptionUnit: 'credits', Requests: '',
            CostUSD: g, discount_amount: dsc, net_amount: n, Email: '', CostSource: 'vendor',
          };
          usage.push(row);
          byRow.set(`${date}|${login}`, row);
        }
      }
    }
    if (exhausted) log(`per-user dollars stopped after ${done} calls: the budget of ${limit} calls an hour is used up; the rest of the window stays allocated`);
  }

  progress('people', { table: 'teams', rows: 0, message: 'Reading organizations, teams and seats' });
  const teams = orgList().length ? await readTeams(log, progress) : { values: [], seats: null, seatsByOrg: {}, skipped: [] };
  if (!orgList().length) log('github.orgs is blank: teams and seats skipped');

  let userUsd = 0;
  for (const r of usage) if (r.PersonKey !== UNATTRIBUTED) userUsd += Number(r.CostUSD) || 0;
  const coverage = {
    org_total_usd: round6(orgGross),
    user_rows_usd: round6(userUsd),
    data_refreshed_at: lastReady ? `${lastReady}T00:00:00Z` : null,
    licensed_seats: teams.seats,
    licensed_seats_by_org: teams.seatsByOrg,
  };
  if (stoppedAt) coverage.stopped_before = stoppedAt;
  usage.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : a.PersonKey < b.PersonKey ? -1 : a.PersonKey > b.PersonKey ? 1 : 0));
  return { usage, detail, orgs: { values: teams.values }, coverage };
}

// ---- test -----------------------------------------------------------------------------------

async function test() {
  const t0 = Date.now();
  const steps = [];
  const add = (key, ok, lbl, detail) => { steps.push({ key, ok, label: lbl, detail }); return ok; };
  const finish = () => ({ ok: steps.every((s) => s.ok), duration_ms: Date.now() - t0, steps });
  const ALL = [['enterprise', 'Enterprise billing'], ['metrics', 'Copilot metrics'], ['orgs', 'Organizations'], ['seats', 'Copilot seats'], ['rate', 'Rate limit']];
  const notChecked = (why) => {
    for (const [key, lbl] of ALL) add(key, false, lbl, `Not checked: ${why}`);
    return finish();
  };

  let miss = [];
  try { miss = problems(); } catch (e) { miss = [e.message]; }
  if (miss.length) {
    add('auth', false, 'Access token', `Not configured: ${miss.join(', ')}`);
    return notChecked('not configured');
  }
  try {
    const who = await client.get('/user');
    add('auth', true, 'Access token', `Signed in as ${who && who.login ? who.login : 'an unnamed identity'}; ${client.rate.remaining !== null ? client.rate.remaining + ' requests left this hour' : 'rate budget not reported'}`);
  } catch (e) {
    if (e.upstreamStatus === 403 || e.upstreamStatus === 404) {
      // App installation tokens cannot call /user; fall back to the rate limit endpoint.
      try {
        await client.get('/rate_limit');
        add('auth', true, 'Access token', 'The token was accepted (it has no user identity, as with an installation token)');
      } catch (e2) {
        add('auth', false, 'Access token', e2.message);
        return notChecked('the token was not accepted');
      }
    } else {
      add('auth', false, 'Access token', e.message);
      return notChecked('the token was not accepted');
    }
  }

  const now = time.now();
  const ym = ymd(now.toISOString().slice(0, 10));
  try {
    const b = await client.get(entPath('/settings/billing/usage'), [['year', ym.year], ['month', ym.month]]);
    const n = Array.isArray(b.usageItems) ? b.usageItems.length : 0;
    add('enterprise', true, 'Enterprise billing', `${n} billing usage items for ${ym.year}-${String(ym.month).padStart(2, '0')} (first page of the response)`);
  } catch (e) {
    add('enterprise', false, 'Enterprise billing', e.message);
  }

  const mday = win.addDays(now.toISOString().slice(0, 10), -3);
  try {
    const m = await client.get(entPath('/copilot/metrics/reports/users-1-day'), [['day', mday]]);
    const n = Array.isArray(m.download_links) ? m.download_links.length : 0;
    add('metrics', true, 'Copilot metrics', `${n} report download link${n === 1 ? '' : 's'} for ${mday}`);
  } catch (e) {
    if (e.notFound) add('metrics', false, 'Copilot metrics', `The users-1-day report for ${mday} answered 404: ${e.message}. Check the Copilot usage metrics policy and the enterprise slug.`);
    else add('metrics', false, 'Copilot metrics', e.message);
  }

  const orgs = orgList();
  if (!orgs.length) {
    add('orgs', true, 'Organizations', 'No organizations listed; teams and seats are skipped');
    add('seats', true, 'Copilot seats', 'Skipped (no organizations listed)');
  } else {
    const okOrgs = [];
    const badOrgs = [];
    for (const o of orgs) {
      try { await client.get(`/orgs/${encodeURIComponent(o)}`); okOrgs.push(o); } catch (e) { badOrgs.push(`${o}: ${e.message}`); }
    }
    add('orgs', badOrgs.length === 0, 'Organizations', badOrgs.length ? badOrgs.join('; ') : `${okOrgs.length} organization${okOrgs.length === 1 ? '' : 's'} readable`);
    const counts = [];
    const seatBad = [];
    for (const o of okOrgs) {
      try {
        const s = await client.get(`/orgs/${encodeURIComponent(o)}/copilot/billing/seats`, [['per_page', 1]]);
        counts.push(`${o}: ${s && s.total_seats !== undefined ? s.total_seats : '?'}`);
      } catch (e) { seatBad.push(`${o}: ${e.message}`); }
    }
    add('seats', seatBad.length === 0, 'Copilot seats', seatBad.length ? seatBad.join('; ') : `Seats by organization: ${counts.join(', ')}`);
  }

  if (client.rate.remaining === null) add('rate', true, 'Rate limit', 'GitHub did not report a rate limit');
  else {
    const reset = client.rate.reset ? new Date(client.rate.reset * 1000).toISOString() : 'unknown';
    add('rate', client.rate.remaining >= 50, 'Rate limit', `${client.rate.remaining} requests remaining, resets ${reset}`);
  }
  return finish();
}

module.exports = {
  id, label, platform, describe, problems, enabled, rebuildDays, historyFloor, maxDaysBack: MAX_DAYS_BACK, test, pull,
  normLogin, UNATTRIBUTED,
};
