'use strict';
// Microsoft Copilot Cowork connector (CONTRACT section 18.5). Built blind: no tenant was reachable when this
// was written. The beta userBalances shape, the period of consumedQuantity and the Cowork service ids are all
// UNVERIFIED, so every field is read defensively and the Test connection checklist is the fix loop.
// One snapshot per pull: Date = run date (UTC), Credits = month-to-date consumed credits per user.
const settings = require('../settings');
const time = require('../time');
const gc = require('./graphClient');
const { badRequest } = require('../../errors');

const id = 'cowork';
const label = 'Microsoft Copilot Cowork';
const platform = 'cowork';
const HARD_FLOOR = '2026-01-01';
const CONCEALED = /^[0-9a-f]{16,}$/i;

const enabled = () => !!settings.get('cowork.enabled', false);
// A snapshot is replaced by the next pull's snapshot; there is no trailing window to rebuild.
const rebuildDays = () => 0;
const historyFloor = () => HARD_FLOOR;

function problems() {
  const out = [];
  if (!String(settings.get('cowork.tenant_id', '') || '').trim()) out.push('tenant id');
  if (!String(settings.get('cowork.client_id', '') || '').trim()) out.push('client id');
  if (!settings.getSecret('cowork.client_secret')) out.push('client secret');
  return out;
}

function describe() {
  return {
    fields: [
      { key: 'cowork.tenant_id', label: 'Tenant ID', type: 'text', required: true, hint: 'Directory (tenant) ID of the Entra app registration' },
      { key: 'cowork.client_id', label: 'Application (client) ID', type: 'text', required: true },
      { key: 'cowork.client_secret', label: 'Client secret', type: 'secret', hint: 'Application permissions Reports.Read.All and User.Read.All, admin consent granted' },
      {
        key: 'cowork.users_source', label: 'User list source', type: 'select',
        options: [
          { value: 'copilot_report', label: 'Copilot usage report (licensed users with activity)' },
          { value: 'all_licensed', label: 'All licensed users (works when names are concealed)' },
        ],
      },
      { key: 'cowork.service_ids', label: 'Service ids to count', type: 'text', placeholder: 'blank = every service', hint: 'Comma list of serviceId values from userBalances (names such as workIQ are unverified)' },
      { key: 'cowork.graph_base', label: 'Graph base URL', type: 'text', advanced: true },
      { key: 'cowork.login_base', label: 'Login base URL', type: 'text', advanced: true },
    ],
    limits: {
      pace_ms: 200, batch_size: gc.BATCH_MAX, history: 'none (snapshot of month-to-date credits per run)',
      delegated_only: 'userBalances needs an administrator sign-in (device code); an app-only token cannot read it',
    },
    lag: 'Credits are a snapshot of the month so far at the time of the pull; the Microsoft service reports its own last-modified time per balance.',
    history_floor: historyFloor(),
    help: [
      'The Entra app registration must allow public client flows (Authentication, Allow public client flows: Yes) for the administrator sign-in.',
      'Click Sign in as administrator, open the link, enter the code, and sign in with an account that holds a Copilot cost management role. The refresh token is stored encrypted and never shown.',
      'Credits are computed to USD with the Copilot Cowork rate on the Settings page; Microsoft returns no USD.',
    ],
    actions: [{ key: 'devicecode', label: 'Sign in as administrator', kind: 'devicecode' }],
  };
}

// ---- device code flow ---------------------------------------------------------------------

const flow = { device_code: null, user_code: null, state: 'idle', detail: '', interval: 5, next_poll: 0, expires_at: 0 };

async function startDevice() {
  const r = await gc.deviceStart();
  flow.device_code = r.device_code;
  flow.user_code = r.user_code;
  flow.state = 'pending';
  flow.detail = '';
  flow.interval = Math.max(1, Number(r.interval) || 5);
  flow.next_poll = gc.now() + flow.interval * 1000;
  flow.expires_at = gc.now() + (Number(r.expires_in) || 900) * 1000;
  return {
    user_code: r.user_code,
    verification_uri: r.verification_uri || r.verification_url || 'https://microsoft.com/devicelogin',
    expires_in: Number(r.expires_in) || 900,
    message: r.message || `Open ${r.verification_uri} and enter the code ${r.user_code}.`,
  };
}

async function statusDevice() {
  if (flow.state === 'idle') return { state: 'error', detail: 'No sign-in is in progress. Start one first.' };
  if (flow.state !== 'pending') return { state: flow.state, detail: flow.detail };
  if (gc.now() >= flow.expires_at) {
    flow.state = 'error';
    flow.detail = 'The sign-in code expired. Start again.';
    return { state: flow.state, detail: flow.detail };
  }
  if (gc.now() < flow.next_poll) return { state: 'pending', detail: '' };
  const r = await gc.devicePoll(flow.device_code);
  if (r.state === 'pending') {
    if (r.slowDown) flow.interval += 5;
    flow.next_poll = gc.now() + flow.interval * 1000;
    return { state: 'pending', detail: '' };
  }
  if (r.state === 'error') {
    flow.state = 'error';
    flow.detail = r.error === 'expired_token' ? 'The sign-in code expired. Start again.'
      : r.error === 'authorization_declined' || r.error === 'access_denied' ? 'The sign-in was declined.' : `${r.error}: ${r.detail}`;
    return { state: 'error', detail: flow.detail };
  }
  if (!r.json.refresh_token) {
    flow.state = 'error';
    flow.detail = 'Microsoft returned no refresh token. Check that offline_access is allowed for the app.';
    return { state: 'error', detail: flow.detail };
  }
  gc.storeRefreshToken(r.json.refresh_token);
  let who = 'signed in';
  try {
    const m = await gc.me(r.json.access_token);
    who = String(m.userPrincipalName || m.displayName || who);
  } catch (e) { /* the account name is a courtesy */ }
  flow.state = 'done';
  flow.detail = who;
  return { state: 'done', detail: who };
}

const actions = {
  devicecode: { start: startDevice, status: statusDevice },
};

// ---- helpers --------------------------------------------------------------------------------

const lc = (v) => String(v === null || v === undefined ? '' : v).trim().toLowerCase();
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const serviceFilter = () => new Set(String(settings.get('cowork.service_ids', '') || '').split(',').map(lc).filter(Boolean));
const usersSource = () => (settings.get('cowork.users_source', 'copilot_report') === 'all_licensed' ? 'all_licensed' : 'copilot_report');

const upnOf = (row) => String(row['User Principal Name'] || row.userPrincipalName || row['User ID'] || '').trim();

function isConcealed(upns) {
  return upns.length > 0 && upns.every((u) => CONCEALED.test(u.split('@')[0]));
}

// Users to read balances for: [{id, upn, email, name, department, company}].
async function readUsers(appTok, log) {
  const shape = (u) => ({
    id: String(u.id), upn: lc(u.userPrincipalName), email: lc(u.mail) || lc(u.userPrincipalName),
    name: String(u.displayName || '').trim(), department: String(u.department || '').trim(), company: String(u.companyName || '').trim(),
  });
  if (usersSource() === 'all_licensed') {
    const list = (await gc.licensedUsers(appTok)).filter((u) => u && u.id && u.userPrincipalName);
    return { users: list.map(shape), concealed: false, missing: 0 };
  }
  const rep = await gc.copilotUserReport(appTok, 'D30');
  const upns = [...new Set(rep.rows.map(upnOf).filter(Boolean))];
  if (isConcealed(upns)) return { users: [], concealed: true, missing: 0 };
  const found = await gc.usersByUpn(upns, appTok);
  const users = [];
  let missing = 0;
  for (const u of upns) {
    const e = found.get(u.toLowerCase());
    if (e && e.id) users.push(shape(e)); else missing += 1;
  }
  if (missing) log(`${missing} of ${upns.length} users in the Copilot report were not found in Entra`);
  return { users, concealed: false, missing };
}

let loggedBalance = false;
function logFirstBalance(body, log) {
  if (loggedBalance || !body || !(process.env.AIXP_DEBUG === '1' || process.env.LOG_LEVEL === 'debug')) return;
  loggedBalance = true;
  log(`debug: first raw userBalances keys: ${Object.keys(body).join(',')}; serviceBalances[0] keys: ${Object.keys((Array.isArray(body.serviceBalances) && body.serviceBalances[0]) || {}).join(',')}`);
}

// ---- pull -----------------------------------------------------------------------------------

async function pull({ log = () => {}, progress = () => {} } = {}) {
  const miss = problems();
  if (miss.length) throw badRequest(`Cowork is not configured: ${miss.join(', ')}`);
  progress('auth', { message: 'Signing in to Microsoft Graph' });
  const appTok = await gc.appToken();
  const del = await gc.delegatedToken();
  if (!del) throw badRequest('Cowork needs an administrator sign-in: use Sign in as administrator on the connector card first');

  progress('people', { table: 'users', rows: 0, message: 'Reading the user list' });
  const { users, concealed } = await readUsers(appTok, log);
  if (concealed) {
    throw badRequest('Cowork user names are concealed in the admin center reports setting; unconceal them there or set the user list source to All licensed users');
  }
  progress('people', { table: 'users', rows: users.length, message: `${users.length} users resolved` });

  const filter = serviceFilter();
  const day = time.now().toISOString().slice(0, 10);
  const rate = Number(settings.get('cowork.rate', 0.008)) || 0;
  const usage = [];
  const detail = [];
  let newest = null;
  let noBalance = 0;
  let zero = 0;
  const bal = await gc.userBalances(users.map((u) => u.id), del);
  for (const u of users) {
    const r = bal.get(String(u.id));
    if (!r || r.status === 404) { noBalance += 1; continue; }
    if (r.status === 401 || r.status === 403) {
      throw badRequest(`Microsoft refused the balances read (HTTP ${r.status}): the signed-in administrator needs CopilotCostManagement-UserData.Read.All and an eligible role`);
    }
    if (r.status !== 200 || !r.body) { log(`balance for ${u.upn}: HTTP ${r.status}, skipped`); noBalance += 1; continue; }
    logFirstBalance(r.body, log);
    const list = Array.isArray(r.body.serviceBalances) ? r.body.serviceBalances : [];
    let credits = 0;
    let used = 0;
    for (const s of list) {
      const sid = String((s && s.serviceId) || '').trim();
      const q = num(s && s.consumedQuantity);
      const mod = s && s.dataStatus && s.dataStatus.lastModifiedDateTime;
      if (mod && (!newest || mod > newest)) newest = mod;
      if (q === null) continue;
      if (filter.size && !filter.has(lc(sid))) continue;
      credits += q;
      used += 1;
      detail.push({
        vendor: id, date: day, person_key: u.email, email: u.email, model: '', product: sid || 'unknown',
        // credits, not tokens: the detail table has no credits column
        tokens: q, cost_usd: q * rate, list_cost_usd: q * rate, requests: null,
      });
    }
    if (!used || credits <= 0) { zero += 1; continue; }
    usage.push({
      Date: day, PersonKey: u.email, Platform: platform, Model: '', Tokens: '', Credits: credits, ConsumptionUnit: 'credits',
      CostUSD: '', Requests: '', Email: u.email,
    });
  }
  log(`${usage.length} users with credits, ${zero} with none, ${noBalance} without a balance record`);
  progress('usage', { table: 'balances', rows: usage.length, message: `${usage.length} user snapshots` });

  // Organizations: Entra department, and companyName when present.
  const orgMap = new Map();
  const addOrg = (value, u) => {
    if (!value) return;
    if (!orgMap.has(value)) orgMap.set(value, new Map());
    orgMap.get(value).set(u.email, { person_key: u.email, email: u.email, display_name: u.name });
  };
  for (const u of users) { addOrg(u.department, u); addOrg(u.company, u); }
  const orgs = { values: [...orgMap].map(([value, m]) => ({ value, people: [...m.values()] })) };

  let tenantBalance = null;
  try { tenantBalance = await gc.tenantBalance(del); } catch (e) { log(`getTenantCreditBalance not read: ${e.message}`); }
  usage.sort((a, b) => (a.PersonKey < b.PersonKey ? -1 : 1));
  detail.sort((a, b) => (a.person_key < b.person_key ? -1 : a.person_key > b.person_key ? 1 : a.product < b.product ? -1 : 1));
  return {
    usage, detail, orgs,
    coverage: { org_total_usd: null, user_rows_usd: null, data_refreshed_at: newest, tenant_balance: tenantBalance },
  };
}

// ---- test -----------------------------------------------------------------------------------

async function test() {
  const t0 = Date.now();
  const steps = [];
  const add = (key, ok, lbl, detail) => { steps.push({ key, ok, label: lbl, detail }); return ok; };
  const finish = () => ({ ok: steps.every((s) => s.ok), duration_ms: Date.now() - t0, steps });
  const skip = (list, why) => { for (const [key, lbl] of list) add(key, false, lbl, `Not checked: ${why}`); return finish(); };
  const REST = [['report', 'Copilot usage report'], ['users', 'User lookup'], ['admin_signin', 'Administrator sign-in'], ['balances', 'User balances'], ['tenant_balance', 'Tenant credit balance']];

  let miss = [];
  try { miss = problems(); } catch (e) { miss = [e.message]; }
  if (miss.length) {
    add('app_auth', false, 'App sign-in', `Not configured: ${miss.join(', ')}`);
    return skip(REST, 'the app registration is not configured');
  }
  let appTok;
  try {
    appTok = await gc.appToken();
    add('app_auth', true, 'App sign-in', 'A Graph token was issued for the client credentials');
  } catch (e) {
    add('app_auth', false, 'App sign-in', e.message);
    return skip(REST, 'the app sign-in failed');
  }

  let sample = [];
  const src = usersSource();
  if (src === 'copilot_report') {
    try {
      const rep = await gc.copilotUserReport(appTok, 'D30');
      const upns = [...new Set(rep.rows.map(upnOf).filter(Boolean))];
      const hid = isConcealed(upns);
      add('report', !hid, 'Copilot usage report', hid
        ? `${upns.length} users, but names are concealed in the admin center reports setting; unconceal them or use All licensed users`
        : `${upns.length} users in the D30 report (${rep.path})`);
      sample = hid ? [] : upns.slice(0, 5);
    } catch (e) {
      add('report', false, 'Copilot usage report', e.message);
    }
  } else {
    add('report', true, 'Copilot usage report', 'Not used: the user list source is All licensed users');
  }

  let ids = [];
  try {
    if (src === 'all_licensed') {
      const list = (await gc.licensedUsers(appTok)).filter((u) => u && u.id);
      ids = list.slice(0, 5).map((u) => String(u.id));
      add('users', list.length > 0, 'User lookup', `${list.length} licensed users`);
    } else if (sample.length) {
      const found = await gc.usersByUpn(sample, appTok);
      ids = [...found.values()].map((u) => String(u.id));
      add('users', found.size > 0, 'User lookup', `${found.size} of ${sample.length} sampled users resolved to Entra ids`);
    } else {
      add('users', false, 'User lookup', 'Not checked: the report gave no usable user names');
    }
  } catch (e) {
    add('users', false, 'User lookup', e.message);
  }

  let del = null;
  try {
    del = await gc.delegatedToken();
    if (del) add('admin_signin', true, 'Administrator sign-in', 'The stored refresh token produced a delegated token');
    else add('admin_signin', false, 'Administrator sign-in', 'Sign in as administrator first');
  } catch (e) {
    add('admin_signin', false, 'Administrator sign-in', e.message);
  }
  if (!del) {
    add('balances', false, 'User balances', 'Not checked: no administrator sign-in');
    add('tenant_balance', false, 'Tenant credit balance', 'Not checked: no administrator sign-in');
    return finish();
  }

  if (!ids.length) add('balances', false, 'User balances', 'Not checked: no user id to read');
  else {
    try {
      const r = (await gc.userBalances([ids[0]], del)).get(ids[0]);
      if (r && r.status === 200 && r.body) {
        const list = Array.isArray(r.body.serviceBalances) ? r.body.serviceBalances : [];
        const txt = list.map((s) => `${s.serviceId || '?'}=${s.consumedQuantity === undefined ? '?' : s.consumedQuantity}${s.unit ? ' ' + s.unit : ''}`).join(', ');
        add('balances', true, 'User balances', list.length ? `${list.length} service balances: ${txt}` : 'The user has no service balances');
      } else if (r && r.status === 404) add('balances', true, 'User balances', 'The sampled user has no balance record (HTTP 404)');
      else if (r && (r.status === 401 || r.status === 403)) add('balances', false, 'User balances', `Microsoft refused the read (HTTP ${r.status}); the administrator needs CopilotCostManagement-UserData.Read.All and an eligible role`);
      else add('balances', false, 'User balances', `Microsoft answered HTTP ${r ? r.status : 'none'}`);
    } catch (e) {
      add('balances', false, 'User balances', e.message);
    }
  }
  try {
    const t = await gc.tenantBalance(del);
    const rows = Array.isArray(t.billingMethodBalances) ? t.billingMethodBalances : [];
    add('tenant_balance', true, 'Tenant credit balance', rows.length
      ? rows.map((b) => `${b.billingMethod || '?'}: consumed ${b.consumedQuantity === undefined ? '?' : b.consumedQuantity}, remaining ${b.remainingQuantity === undefined ? '?' : b.remainingQuantity}`).join('; ')
      : 'No billing method balances were returned');
  } catch (e) {
    add('tenant_balance', false, 'Tenant credit balance', e.message);
  }
  return finish();
}

module.exports = {
  id, label, platform, describe, problems, enabled, rebuildDays, historyFloor, maxDaysBack: null, test, pull, actions,
  isConcealed,
};
