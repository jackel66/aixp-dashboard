'use strict';
// OpenAI connector (CONTRACT section 18.4) against two fake servers: the API platform (usage/completions,
// costs, users with paging, a 400 on group_by user_id, a 429) and ChatGPT Enterprise (an hourly costs route in a
// plausible but UNVERIFIED shape, a 404 branch, JSONL branch). Pacing is asserted on an injected clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setup, teardown, startApp } = require('./helpers');

const ADMIN_KEY = 'sk-admin-API-key-0123456789';
const BAD_KEY = 'sk-admin-BAD-key-9876543210';
const ENT_KEY = 'sk-admin-ENT-key-abcdefghij';
const ORG = 'org-TESTORG123';
process.env.AIXP_SECRET_KEY = 'c3'.repeat(32);

const ctx = setup();
const db = ctx.db.getDb();
const { seedFixture } = require('./seed');
const client = require('../src/services/connectors/openaiClient');
const openai = require('../src/services/connectors/openai');
const connectors = require('../src/services/connectors');
const imp = require('../src/services/vendorImport');
const settings = require('../src/services/settings');
const datasets = require('../src/services/datasets');
const time = require('../src/services/time');

const NOW = '2026-11-04T08:30:00Z';
const TODAY = '2026-11-04';
const FROM = '2026-10-01';
const TO = '2026-11-04T08:00:00.000Z';
const DATA_FIRST = '2026-10-01';
const DATA_LAST = '2026-10-30';
const T = { v: Date.parse(NOW) };
const sleeps = [];
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

// ---- fake data ----------------------------------------------------------------------------

const MODELS = ['gpt-5', 'gpt-4.1'];
const USERS = [
  { id: 'user_001', email: 'u1@example.com', nested: null, models: MODELS },
  { id: 'user_002', email: null, nested: 'u2.nested@example.com', models: [MODELS[0]] },
  { id: 'user_003', email: null, nested: null, models: MODELS }, // no e-mail anywhere
  { id: 'user_004', email: 'u4@example.com', nested: null, models: [MODELS[0]] },
];
const COST_ONLY = 'user_costonly'; // a cost row with no usage rows

const days = [];
for (let ms = dayMs(DATA_FIRST); ms <= dayMs(DATA_LAST); ms += 86400000) days.push(new Date(ms).toISOString().slice(0, 10));

function genApi() {
  const usage = []; // {day, uid, model, input, output, req}
  const costs = []; // {day, uid, value, currency, line}
  days.forEach((day, d) => {
    USERS.forEach((u, i) => {
      if ((i + d) % 4 === 0) return;
      u.models.forEach((model, mi) => {
        const input = 4000 + ((i * 7919 + d * 104729 + mi * 31) % 5000);
        usage.push({ day, uid: u.id, model, input, output: Math.round(input * 0.25), req: 4 + ((i + d) % 7) });
      });
      costs.push({ day, uid: u.id, value: 0.5 + ((i * 3 + d) % 7) * 0.25, currency: 'usd', line: 'gpt-5, input_tokens' });
    });
    if (d % 6 === 0) { // project-level usage with no user
      usage.push({ day, uid: null, model: MODELS[0], input: 900, output: 100, req: 2 });
      costs.push({ day, uid: null, value: 0.33, currency: 'usd', line: 'gpt-5, input_tokens' });
    }
    if (d === 5) costs.push({ day, uid: COST_ONLY, value: 1.1, currency: 'usd', line: 'gpt-5, output_tokens' });
    if (d === 7) costs.push({ day, uid: USERS[0].id, value: 9, currency: 'eur', line: 'gpt-5, input_tokens' }); // skipped
  });
  return { usage, costs };
}

// Hourly Enterprise records; two hours on one day roll into one row. The record shape is a guess.
const ENT_RECS = [
  { timestamp: '2026-10-20T10:00:00Z', user: { email: 'A@Example.com' }, model: 'gpt-5.1', total_tokens: 1000, billing_cost_value: 2.5, billing_estimated_cost_usd_value: 0.1 },
  { timestamp: '2026-10-20T15:00:00Z', user: { email: 'a@example.com' }, model: 'gpt-5.1', total_tokens: 500, billing_cost_value: 1.5, billing_estimated_cost_usd_value: 0.06 },
  { timestamp: '2026-10-21T23:30:00Z', user: { email: 'b@example.com' }, model: 'o3', input_tokens: 300, output_tokens: 200, billing_cost_value: 4, billing_estimated_cost_usd_value: 0.16 },
  { timestamp: '2026-10-22T01:00:00Z', user: { email: 'b@example.com' }, model: 'o3', input_tokens: 100, output_tokens: 50, billing_cost_value: 1, billing_estimated_cost_usd_value: 0.04 },
  { timestamp: '2026-10-22T02:00:00Z', model: 'gpt-5.1', total_tokens: 70, billing_cost_value: 0.5, billing_estimated_cost_usd_value: 0.02 }, // no user
  { timestamp: '2026-10-01T10:00:00Z', user: { email: 'old@example.com' }, model: 'o3', total_tokens: 10, billing_cost_value: 9, billing_estimated_cost_usd_value: 0.3 }, // before the 30 day floor
];

// ---- fake servers -------------------------------------------------------------------------

const fake = {
  apiBase: '', entBase: '', apiServer: null, entServer: null, calls: [], entCalls: [], used: new Set(),
  throttle: 0, costs400: false, entNotFound: false, entJsonl: false, strictAfter: true, entPageSize: 2,
  usage: [], costs: [], usersCalls: 0,
};

const err = (res, status, message) => res.status(status).json({ error: { message, type: 'invalid_request_error' } });

function bucketize(rows, startS, endS, make) {
  const out = [];
  for (let s = startS; s < endS; s += 86400) {
    const day = new Date(s * 1000).toISOString().slice(0, 10);
    const inDay = rows.filter((r) => r.day === day);
    if (!inDay.length) continue;
    out.push({ object: 'bucket', start_time: s, end_time: s + 86400, results: inDay.map(make) });
  }
  return out;
}

function pageOut(req, res, buckets, pageCap, maxLimit) {
  const limit = Math.min(pageCap, Number(req.query.limit) || 7);
  if (Number(req.query.limit) > maxLimit) return err(res, 400, `limit must be at most ${maxLimit}`);
  let offset = 0;
  if (req.query.page) {
    if (fake.used.has(req.path + req.query.page)) return err(res, 400, 'cursor already used');
    fake.used.add(req.path + req.query.page);
    offset = Number(Buffer.from(String(req.query.page), 'base64url').toString('utf8'));
  }
  const slice = buckets.slice(offset, offset + limit);
  const has = offset + limit < buckets.length;
  return res.json({ object: 'page', data: slice, has_more: has, next_page: has ? Buffer.from(String(offset + limit)).toString('base64url') : null });
}

function buildApi() {
  const app = express();
  app.use((req, res, next) => {
    fake.calls.push({ path: req.path, t: T.v, q: req.query, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${ADMIN_KEY}`) return err(res, 401, 'Incorrect API key provided');
    if (fake.throttle > 0 && req.path !== '/v1/organization/users') {
      fake.throttle -= 1;
      res.set('Retry-After', '2');
      return err(res, 429, 'Rate limit reached');
    }
    return next();
  });
  const window = (req) => [Number(req.query.start_time), Number(req.query.end_time)];
  app.get('/v1/organization/usage/completions', (req, res) => {
    const [s, e] = window(req);
    if (!Number.isInteger(s) || !Number.isInteger(e)) return err(res, 400, 'start_time and end_time must be Unix seconds');
    if (req.query.bucket_width !== '1d') return err(res, 400, 'bucket_width 1d only');
    const gb = [].concat(req.query.group_by || []);
    if (!gb.includes('user_id') || !gb.includes('model')) return err(res, 400, 'group_by user_id and model expected');
    const b = bucketize(fake.usage, s, e, (r) => ({
      object: 'organization.usage.completions.result', input_tokens: r.input, output_tokens: r.output, input_cached_tokens: 0,
      num_model_requests: r.req, user_id: r.uid, model: r.model,
    }));
    return pageOut(req, res, b, 10, 31);
  });
  app.get('/v1/organization/costs', (req, res) => {
    const [s, e] = window(req);
    const gb = [].concat(req.query.group_by || []);
    if (gb.includes('user_id') && fake.costs400) return err(res, 400, 'group_by user_id is not supported for costs');
    let rows = fake.costs;
    if (!gb.includes('user_id')) {
      // grouped by line_item only: one row per day and line item, user_id null
      const m = new Map();
      for (const r of rows) {
        const k = `${r.day}|${r.line}|${r.currency}`;
        const cur = m.get(k) || { day: r.day, uid: null, value: 0, currency: r.currency, line: r.line };
        cur.value += r.value;
        m.set(k, cur);
      }
      rows = [...m.values()];
    }
    const b = bucketize(rows, s, e, (r) => ({
      object: 'organization.costs.result', amount: { value: r.value, currency: r.currency }, line_item: r.line, user_id: r.uid,
    }));
    return pageOut(req, res, b, 12, 180);
  });
  app.get('/v1/organization/users', (req, res) => {
    fake.usersCalls += 1;
    const limit = Math.min(2, Number(req.query.limit) || 20);
    const all = USERS.map((u) => ({ object: 'organization.user', id: u.id, name: u.id, email: u.email || undefined, user: u.nested ? { id: u.id, email: u.nested } : undefined, role: 'reader' }));
    let start = 0;
    if (req.query.after) start = all.findIndex((x) => x.id === req.query.after) + 1;
    const slice = all.slice(start, start + limit);
    return res.json({ object: 'list', data: slice, first_id: slice[0] && slice[0].id, last_id: slice[slice.length - 1] && slice[slice.length - 1].id, has_more: start + limit < all.length });
  });
  return app;
}

function buildEnt() {
  const app = express();
  app.get('/v1/compliance/organizations/:org/costs', (req, res) => {
    fake.entCalls.push({ t: T.v, q: req.query, org: req.params.org, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${ENT_KEY}`) return err(res, 401, 'invalid admin key');
    if (fake.entNotFound) return err(res, 404, 'not found');
    let rows = ENT_RECS;
    if (fake.strictAfter && req.query.after) rows = rows.filter((r) => Date.parse(r.timestamp) >= Date.parse(req.query.after));
    const limit = Math.min(fake.entPageSize, Number(req.query.limit) || 500);
    const offset = req.query.page ? Number(Buffer.from(String(req.query.page), 'base64url').toString('utf8')) : 0;
    const slice = rows.slice(offset, offset + limit);
    const has = offset + limit < rows.length;
    if (fake.entJsonl) {
      res.type('text/plain');
      return res.send(slice.map((r) => JSON.stringify(r)).join('\n'));
    }
    return res.json({ data: slice, has_more: has, next_page: has ? Buffer.from(String(offset + limit)).toString('base64url') : null });
  });
  return app;
}

// ---- helpers ------------------------------------------------------------------------------

let app;
let admin;
let baseId;
let baseCounts;
const put = (patch) => admin.call('PUT', '/api/settings', { patch });
const platformCounts = (id) => Object.fromEntries(db.prepare('SELECT platform, count(*) n FROM usage WHERE dataset_id = ? GROUP BY platform').all(id).map((r) => [r.platform, r.n]));

async function configure(extra) {
  const r = await put(Object.assign({
    'openai.enabled': true, 'openai.admin_key': ADMIN_KEY, 'openai.base_url': fake.apiBase + '/',
    'openai.enterprise_key': ENT_KEY, 'openai.enterprise_org_id': ORG, 'openai.enterprise_base_url': fake.entBase + '/',
    'vendors.months_back': 2,
  }, extra || {}));
  assert.equal(r.status, 200, r.text);
}
async function onlyApi() { await configure({ 'openai.enterprise_key': null }); }
async function onlyEnt() { await configure({ 'openai.admin_key': null }); }

function resetFake() {
  fake.calls.length = 0; fake.entCalls.length = 0; fake.used.clear(); fake.throttle = 0; fake.costs400 = false;
  fake.entNotFound = false; fake.entJsonl = false; fake.strictAfter = true; fake.entPageSize = 2; fake.usersCalls = 0;
  sleeps.length = 0;
  client.resetStats();
  client.resetPacer();
}

test.before(async () => {
  seedFixture({ months: 3, people: 120, profile: 'clean', endDate: DATA_LAST, label: 'baseline fixture' });
  baseId = datasets.active().id;
  baseCounts = platformCounts(baseId);
  const g = genApi();
  fake.usage = g.usage;
  fake.costs = g.costs;
  fake.apiServer = buildApi().listen(0);
  fake.entServer = buildEnt().listen(0);
  await Promise.all([fake.apiServer, fake.entServer].map((s) => new Promise((r) => s.once('listening', r))));
  fake.apiBase = `http://127.0.0.1:${fake.apiServer.address().port}`;
  fake.entBase = `http://127.0.0.1:${fake.entServer.address().port}`;
  client.setClock(() => T.v);
  client.setSleep(async (ms) => { sleeps.push(ms); T.v += ms; });
  client.setBackoff(5);
  time.setNow(NOW);
  app = await startApp();
  admin = await app.admin();
  app.call = admin.call;
});
test.after(async () => {
  time.setNow(null);
  client.setClock(null);
  client.setSleep(null);
  client.setBackoff(null);
  if (app) await app.close();
  await Promise.all([fake.apiServer, fake.entServer].map((s) => new Promise((r) => s.close(r))));
  teardown(ctx);
});
test.beforeEach(() => resetFake());

// ---- settings, registry --------------------------------------------------------------------

test('settings: validators, trailing slashes, both keys masked and encrypted', async () => {
  assert.equal((await put({ 'openai.base_url': 'https://proxy.example.com/' })).status, 200);
  assert.equal(settings.get('openai.base_url'), 'https://proxy.example.com');
  assert.equal((await put({ 'openai.base_url': 'ftp://nope' })).status, 400);
  assert.equal((await put({ 'openai.enterprise_base_url': 'not a url' })).status, 400);
  assert.equal((await put({ 'openai.enterprise_base_url': 'https://api.chatgpt.com/' })).status, 200);
  assert.equal(settings.get('openai.enterprise_base_url'), 'https://api.chatgpt.com');
  assert.equal((await put({ 'openai.rebuild_days': 0 })).status, 400);
  assert.equal((await put({ 'openai.rebuild_days': 32 })).status, 400);
  assert.equal((await put({ 'openai.rebuild_days': 3 })).status, 200);
  assert.equal((await put({ 'openai.enterprise_org_id': 'has space' })).status, 400);
  assert.equal((await put({ 'openai.enterprise_org_id': ORG })).status, 200);
  assert.equal((await put({ 'openai.enterprise_costs_path': 'no-slash' })).status, 400);
  assert.equal((await put({ 'openai.enterprise_costs_path': '/v1/other/{org_id}/x' })).status, 200);
  assert.equal((await put({ 'openai.enterprise_costs_path': '/v1/compliance/organizations/{org_id}/costs' })).status, 200);
  assert.equal((await put({ 'openai.enterprise_rate': 'abc' })).status, 400);
  assert.equal((await put({ 'openai.enterprise_rate': '0.04' })).status, 200);
  assert.equal((await put({ 'openai.enterprise_rate': '' })).status, 200);
  for (const [k, v] of [['openai.admin_key', ADMIN_KEY], ['openai.enterprise_key', ENT_KEY]]) {
    const r = await put({ [k]: v });
    assert.deepEqual(r.json[k], { set: true });
    assert.ok(!r.text.includes(v));
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(k).value;
    assert.ok(stored.startsWith('"enc:v1:'), `${k} stored encrypted`);
    assert.ok(!stored.includes(v));
    assert.equal(settings.getSecret(k), v);
    assert.equal((await put({ [k]: { set: true } })).status, 200);
    assert.equal(settings.getSecret(k), v, 'the masked object keeps the key');
    await put({ [k]: null });
    assert.equal(settings.getSecret(k), '');
  }
  const defaults = (await admin.call('GET', '/api/settings')).json;
  assert.equal(defaults['openai.rebuild_days'], 3);
  assert.equal(defaults['openai.enterprise_costs_path'], '/v1/compliance/organizations/{org_id}/costs');
  assert.equal(defaults['openai.enabled'], false);
});

test('problems() and describe(): either key is enough, the org id is needed for the Enterprise path', async () => {
  assert.deepEqual(openai.problems(), ['admin key or enterprise key']);
  await put({ 'openai.enterprise_key': ENT_KEY, 'openai.enterprise_org_id': '' });
  assert.deepEqual(openai.problems(), ['enterprise org id']);
  await put({ 'openai.enterprise_org_id': ORG });
  assert.deepEqual(openai.problems(), []);
  await put({ 'openai.enterprise_key': null, 'openai.admin_key': ADMIN_KEY });
  assert.deepEqual(openai.problems(), []);
  await put({ 'openai.admin_key': null });
  const d = openai.describe();
  assert.equal(d.history_floor, openai.historyFloor());
  const keys = d.fields.map((f) => f.key);
  for (const k of ['openai.admin_key', 'openai.enterprise_key', 'openai.enterprise_org_id', 'openai.rebuild_days', 'openai.enterprise_costs_path']) assert.ok(keys.includes(k), k);
  assert.ok(d.fields.filter((f) => f.type === 'secret').length === 2);
  assert.ok(Array.isArray(d.help) && d.help.length > 0);
  assert.equal(d.fields.find((f) => f.key === 'openai.enterprise_costs_path').advanced, true);
  const reg = connectors.get('openai');
  if (reg) assert.equal(reg.id, 'openai');
});

// ---- test() ---------------------------------------------------------------------------------

test('test(): no key fails the first step, never throws, makes no request', async () => {
  await put({ 'openai.admin_key': null, 'openai.enterprise_key': null });
  const t = await openai.test();
  assert.equal(t.ok, false);
  assert.deepEqual(t.steps.map((s) => s.key), ['api_auth', 'usage', 'costs', 'ent_auth', 'ent_shape']);
  assert.match(t.steps[0].detail, /Not configured: admin key or enterprise key/);
  assert.ok(t.steps.slice(1).every((s) => s.ok === false && /Not checked/.test(s.detail)));
  assert.equal(fake.calls.length + fake.entCalls.length, 0);
});

test('test(): a refused API key quotes the vendor error and hides the key', async () => {
  await onlyApi();
  await put({ 'openai.admin_key': BAD_KEY });
  const r = await app.call('POST', '/api/vendors/openai/test');
  if (!connectors.get('openai')) { assert.equal(r.status, 404); return; }
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.steps[0].key, 'api_auth');
  assert.match(r.json.steps[0].detail, /HTTP 401/);
  assert.match(r.json.steps[0].detail, /Incorrect API key provided/);
  assert.ok(!r.text.includes(BAD_KEY));
  assert.ok(r.json.steps.slice(1, 3).every((s) => /Not checked/.test(s.detail)));
});

test('test(): both sub-sources pass; the shape step names the keys and the mapped columns', async () => {
  fake.strictAfter = false;
  await configure();
  const t = await openai.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.deepEqual(t.steps.map((s) => s.key), ['api_auth', 'usage', 'costs', 'ent_auth', 'ent_shape']);
  assert.match(t.steps[2].detail, /group_by user_id was accepted/);
  assert.match(t.steps[4].detail, /timestamp/);
  assert.match(t.steps[4].detail, /user\.email/);
  assert.match(t.steps[4].detail, /billing_cost_value/);
  assert.match(t.steps[4].detail, /credits <- billing_cost_value/);
  assert.ok(!t.steps[4].detail.includes('example.com'), 'key names only, never values');
});

test('test(): group_by user_id refused is noted, not failed; a missing costs path says what to set; a missing org id fails', async () => {
  fake.strictAfter = false;
  await configure();
  fake.costs400 = true;
  let t = await openai.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.match(t.steps[2].detail, /costs are not attributable per user on this organization/);
  fake.entNotFound = true;
  t = await openai.test();
  assert.equal(t.ok, false);
  assert.equal(t.steps[3].key, 'ent_auth');
  assert.match(t.steps[3].detail, /costs path not found, set openai\.enterprise_costs_path/);
  assert.equal(t.steps[4].ok, false);
  await put({ 'openai.enterprise_org_id': '' });
  t = await openai.test();
  assert.equal(t.steps[3].ok, false);
  assert.match(t.steps[3].detail, /enterprise org id/);
  await put({ 'openai.enterprise_org_id': ORG });
});

test('test(): a sub-source without a key is skipped, not failed', async () => {
  await onlyApi();
  let t = await openai.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.match(t.steps[3].detail, /Not configured, skipped/);
  fake.strictAfter = false;
  await onlyEnt();
  t = await openai.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.match(t.steps[0].detail, /Not configured, skipped/);
});

// ---- A. API platform pull ------------------------------------------------------------------

test('pull(): API platform joins usage and costs, allocates by token share, resolves e-mails, pages and paces', async () => {
  await onlyApi();
  fake.throttle = 1;
  const logs = [];
  const progress = [];
  const r = await openai.pull({ from: FROM, to: TO, log: (m) => logs.push(m), progress: (s, e) => progress.push([s, e]) });

  // windows: 2026-10-01 .. 2026-11-04T08:00 is 34 days + 8 h -> 2 slices of at most 31 days
  const uc = [...new Map(fake.calls.filter((c) => c.path === '/v1/organization/usage/completions' && !c.q.page).map((c) => [c.q.start_time, c])).values()];
  assert.equal(uc.length, 2);
  assert.equal(Number(uc[0].q.start_time), dayMs(FROM) / 1000);
  assert.equal(Number(uc[1].q.start_time), Number(uc[0].q.end_time));
  assert.equal(Number(uc[1].q.end_time), Date.parse(TO) / 1000);
  assert.ok(fake.calls.some((c) => c.q.page), 'follows next_page');
  assert.ok(fake.calls.every((c) => c.auth === `Bearer ${ADMIN_KEY}`));
  assert.ok(fake.calls.filter((c) => c.path !== '/v1/organization/users').every((c) => c.q.bucket_width === '1d'));
  // pacing: 500 ms between every request, retries included; Retry-After 2 s honoured
  assert.ok(fake.calls.length > 8);
  for (let i = 1; i < fake.calls.length; i++) assert.ok(fake.calls[i].t - fake.calls[i - 1].t >= 500, `gap ${i}: ${fake.calls[i].t - fake.calls[i - 1].t}`);
  assert.ok(sleeps.includes(2000), 'Retry-After honoured');
  assert.ok(fake.usersCalls >= 2, 'users paged with after');

  // totals: usage tokens and every USD cost (the EUR row is skipped)
  const usdCosts = fake.costs.filter((c) => c.currency === 'usd');
  assert.equal(r.usage.reduce((a, x) => a + x.Tokens, 0), sum(fake.usage, (u) => u.input + u.output));
  assert.ok(Math.abs(sum(r.usage, (x) => Number(x.CostUSD) || 0) - sum(usdCosts, (c) => c.value)) < 1e-6, 'allocated cost equals the cost total');
  assert.ok(logs.some((m) => /1 cost rows were not in USD/.test(m)));
  assert.ok(r.usage.every((x) => x.Platform === 'openai' && x.ConsumptionUnit === 'tokens' && x.Credits === ''));
  assert.ok(r.usage.every((x) => x.CostSource === '' || ['allocated', 'vendor'].includes(x.CostSource)));

  // e-mail resolution: top-level, nested user.email, and the id fallback
  const keys = new Set(r.usage.map((x) => x.PersonKey));
  assert.ok(keys.has('u1@example.com') && keys.has('u4@example.com'));
  assert.ok(keys.has('u2.nested@example.com'), 'nested e-mail fallback');
  assert.ok(keys.has('openai:user_003'), 'no e-mail anywhere keeps the id');
  assert.ok(keys.has('openai:unattributed'), 'a null user_id is unattributed');
  assert.equal(r.usage.find((x) => x.PersonKey === 'u1@example.com').Email, 'u1@example.com');

  // token-share allocation for one user-day with two models
  const u1 = USERS[0];
  const day = days[1];
  const rows = r.usage.filter((x) => x.PersonKey === 'u1@example.com' && x.Date === day);
  assert.equal(rows.length, 2);
  const cost = fake.costs.find((c) => c.uid === u1.id && c.day === day && c.currency === 'usd').value;
  assert.ok(Math.abs(sum(rows, (x) => x.CostUSD) - cost) < 1e-9, 'shares sum to the day cost');
  const tok = rows.map((x) => x.Tokens);
  assert.ok(Math.abs(rows[0].CostUSD / cost - tok[0] / (tok[0] + tok[1])) < 1e-6, 'share follows tokens');
  assert.ok(rows.every((x) => x.CostSource === 'allocated'));

  // a cost row with no usage rows lands on Model 'unattributed' as a vendor figure
  const only = r.usage.find((x) => x.PersonKey === `openai:${COST_ONLY}`);
  assert.equal(only.Model, 'unattributed');
  assert.equal(only.CostUSD, 1.1);
  assert.equal(only.CostSource, 'vendor');
  assert.equal(only.Tokens, 0);

  // requests, detail and coverage
  assert.equal(r.usage.reduce((a, x) => a + (Number(x.Requests) || 0), 0), sum(fake.usage, (u) => u.req));
  assert.ok(r.detail.every((d) => d.vendor === 'openai' && d.product === 'api'));
  assert.equal(r.detail.length, r.usage.length);
  assert.ok(Math.abs(sum(r.detail, (d) => d.cost_usd) - sum(usdCosts, (c) => c.value)) < 1e-6);
  assert.ok(Math.abs(r.coverage.org_total_usd - sum(usdCosts, (c) => c.value)) < 1e-6);
  const unattributedUsd = sum(r.usage.filter((x) => x.PersonKey === 'openai:unattributed'), (x) => Number(x.CostUSD) || 0);
  assert.ok(Math.abs(r.coverage.user_rows_usd - (r.coverage.org_total_usd - unattributedUsd)) < 1e-6);
  assert.deepEqual(r.orgs, { values: [] });
  // unique at the usage grain
  const grain = new Set(r.usage.map((x) => `${x.Date}|${x.PersonKey}|${x.Model}`));
  assert.equal(grain.size, r.usage.length);
  assert.ok(progress.some(([s]) => s === 'usage'));
  assert.equal(fake.entCalls.length, 0, 'no Enterprise call without its key');
});

test('pull(): costs that cannot be grouped by user are retried by line_item and carried unattributed', async () => {
  await onlyApi();
  fake.costs400 = true;
  const logs = [];
  const r = await openai.pull({ from: FROM, to: TO, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /costs are not attributable per user on this organization/.test(m)));
  assert.ok(fake.calls.some((c) => c.q['group_by[]'] === 'line_item' || [].concat(c.q.group_by || []).includes('line_item')));
  const usdCosts = fake.costs.filter((c) => c.currency === 'usd');
  const userRows = r.usage.filter((x) => x.PersonKey !== 'openai:unattributed');
  assert.ok(userRows.every((x) => x.CostUSD === '' && x.CostSource === ''), 'no per-user dollars invented');
  assert.ok(Math.abs(sum(r.usage, (x) => Number(x.CostUSD) || 0) - sum(usdCosts, (c) => c.value)) < 1e-6, 'the organization cost is still all there');
  assert.equal(r.coverage.user_rows_usd, 0);
  assert.ok(Math.abs(r.coverage.org_total_usd - sum(usdCosts, (c) => c.value)) < 1e-6);
});

test('pull(): a refused key throws with the vendor message and no key text', async () => {
  await onlyApi();
  await put({ 'openai.admin_key': BAD_KEY });
  await assert.rejects(() => openai.pull({ from: FROM, to: TO }), (e) => {
    assert.match(e.message, /HTTP 401/);
    assert.match(e.message, /Incorrect API key provided/);
    assert.ok(!e.message.includes(BAD_KEY));
    return true;
  });
  await put({ 'openai.admin_key': null, 'openai.enterprise_key': null });
  await assert.rejects(() => openai.pull({ from: FROM, to: TO }), /OpenAI is not configured: admin key or enterprise key/);
});

// ---- B. ChatGPT Enterprise -----------------------------------------------------------------

test('pull(): Enterprise records roll to UTC days per user and model, credits and USD stay separate, the 30 day floor holds', async () => {
  await onlyEnt();
  const logs = [];
  const r = await openai.pull({ from: '2026-08-01', to: TO, log: (m) => logs.push(m) });
  // the call asks for no more than 30 days back, org id substituted into the path, key as bearer
  assert.ok(fake.entCalls.length >= 2, 'paged');
  assert.ok(fake.entCalls.every((c) => c.org === ORG && c.auth === `Bearer ${ENT_KEY}`));
  assert.equal(fake.entCalls[0].q.after, '2026-10-05T00:00:00Z');
  assert.equal(fake.entCalls[0].q.limit, '500');
  assert.equal(fake.calls.length, 0, 'no API call without the admin key');
  for (let i = 1; i < fake.entCalls.length; i++) assert.ok(fake.entCalls[i].t - fake.entCalls[i - 1].t >= 500);

  const by = (k, d, m) => r.usage.find((x) => x.PersonKey === k && x.Date === d && x.Model === m);
  const a = by('a@example.com', '2026-10-20', 'gpt-5.1');
  assert.equal(a.Tokens, 1500);
  assert.equal(a.Credits, 4);
  assert.ok(Math.abs(a.CostUSD - 0.16) < 1e-9);
  assert.equal(a.CostSource, 'vendor');
  assert.equal(a.Email, 'a@example.com', 'e-mail lowercased');
  assert.equal(a.Platform, 'openai');
  // input + output tokens when total_tokens is absent; 23:30Z stays on its UTC day
  const b1 = by('b@example.com', '2026-10-21', 'o3');
  assert.equal(b1.Tokens, 500);
  assert.equal(b1.Credits, 4);
  assert.equal(by('b@example.com', '2026-10-22', 'o3').Tokens, 150);
  // no user: unattributed key
  assert.equal(by('openai:unattributed', '2026-10-22', 'gpt-5.1').Credits, 0.5);
  // before the floor: never asked for, never kept
  assert.ok(!r.usage.some((x) => x.PersonKey === 'old@example.com'));
  assert.equal(r.usage.length, 4);
  assert.ok(r.detail.every((d) => d.product === 'chatgpt_enterprise' && d.vendor === 'openai'));
  assert.ok(Math.abs(r.coverage.org_total_usd - 0.38) < 1e-9);
  assert.ok(Math.abs(r.coverage.user_rows_usd - 0.36) < 1e-9);
  // the first record's key names are logged, never values
  const shape = logs.find((m) => /first record keys/.test(m));
  assert.ok(shape && /timestamp/.test(shape) && /user\.email/.test(shape));
  assert.ok(!/example\.com/.test(shape));
});

test('pull(): a JSONL answer and other key spellings are parsed by the shape-tolerant reader', async () => {
  await onlyEnt();
  fake.entJsonl = true;
  fake.entPageSize = 100;
  const r = await openai.pull({ from: '2026-10-01', to: TO });
  assert.equal(r.usage.length, 4);

  const recs = [
    { start_time: 1792000000, actor: { email: 'X@Example.com' }, model: 'm1', input_tokens: 5, output_tokens: 6, credits: 3, estimated_cost_usd: '0.12' },
    { hour: '2026-10-21T05:00:00Z', email: 'x@example.com', model: 'm1', total_tokens: 4, cost_credits: 2 },
    { nothing: 'useful' },
  ];
  const day = new Date(1792000000 * 1000).toISOString().slice(0, 10);
  const p = openai.parseEnterprise(recs, '2026-01-01', '2026-12-31');
  assert.equal(p.skipped, 1);
  assert.equal(p.usage.length, 2);
  const one = p.usage.find((x) => x.Date === day);
  assert.equal(one.Tokens, 11);
  assert.equal(one.Credits, 3);
  assert.equal(one.CostUSD, 0.12);
  assert.equal(one.PersonKey, 'x@example.com');
  const two = p.usage.find((x) => x.Date === '2026-10-21');
  assert.equal(two.CostUSD, '', 'no USD field means no dollars, not zero');
  assert.equal(two.CostSource, '');
  const s = openai.describeShape(recs[0]);
  assert.equal(s.mapped.email, 'actor.email');
  assert.equal(s.mapped.time, 'start_time');
  assert.equal(s.mapped.credits, 'credits');
  assert.equal(s.mapped.usd, 'estimated_cost_usd');
});

// ---- both sub-sources -----------------------------------------------------------------------

test('pull(): both sub-sources land on the openai platform with distinct cost sources; a shared key is summed', async () => {
  await configure();
  const r = await openai.pull({ from: '2026-10-01', to: TO });
  const sources = new Set(r.usage.map((x) => x.CostSource).filter(Boolean));
  assert.deepEqual([...sources].sort(), ['allocated', 'vendor']);
  assert.ok(r.usage.every((x) => x.Platform === 'openai'));
  assert.deepEqual([...new Set(r.detail.map((d) => d.product))].sort(), ['api', 'chatgpt_enterprise']);
  const grain = new Set(r.usage.map((x) => `${x.Date}|${x.PersonKey}|${x.Model}`));
  assert.equal(grain.size, r.usage.length, 'unique at the usage grain');
  const usdCosts = fake.costs.filter((c) => c.currency === 'usd');
  assert.ok(Math.abs(r.coverage.org_total_usd - (sum(usdCosts, (c) => c.value) + 0.38)) < 1e-6);

  const merged = openai.combine([
    { Date: '2026-10-20', PersonKey: 'k@x.com', Platform: 'openai', Model: 'm', Tokens: 10, Credits: '', ConsumptionUnit: 'tokens', CostUSD: 1, Requests: 2, CostSource: 'allocated', Email: 'k@x.com' },
    { Date: '2026-10-20', PersonKey: 'k@x.com', Platform: 'openai', Model: 'm', Tokens: 5, Credits: 3, ConsumptionUnit: 'tokens', CostUSD: 0.5, Requests: '', CostSource: 'vendor', Email: 'k@x.com' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].Tokens, 15);
  assert.equal(merged[0].Credits, 3);
  assert.equal(merged[0].CostUSD, 1.5);
  assert.equal(merged[0].Requests, 2);
  assert.equal(merged[0].CostSource, 'allocated+vendor');
});

test('pull to a dataset: openai rows replace the fixture rows, other platforms carry over (needs the registry entry)', async (t) => {
  if (!connectors.get('openai')) { t.skip('connectors/index.js does not list openai yet (builder S)'); return; }
  await configure();
  assert.equal(datasets.active().id, baseId);
  const r = await app.call('POST', '/api/vendors/pull', { ids: ['openai'] });
  assert.equal(r.status, 200, r.text);
  const ds = datasets.active();
  assert.equal(ds.id, r.json.dataset_id);
  assert.deepEqual(ds.options.connectors, ['openai']);
  const counts = platformCounts(ds.id);
  for (const p of ['anthropic', 'github', 'cowork']) assert.equal(counts[p], baseCounts[p], `${p} rows carried over`);
  assert.ok(counts.openai > 0);
  const usdCosts = fake.costs.filter((c) => c.currency === 'usd' && c.day >= '2026-09-01');
  const got = db.prepare("SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND platform = 'openai'").get(ds.id).c;
  assert.ok(Math.abs(got - (sum(usdCosts, (c) => c.value) + 0.38)) < 1e-6);
  const extras = db.prepare("SELECT DISTINCT json_extract(extra_json, '$.CostSource') cs FROM stage_usage WHERE dataset_id = ? AND platform = 'openai'").all(ds.id).map((x) => x.cs);
  assert.ok(extras.includes('allocated') && extras.includes('vendor'));
  const matched = db.prepare("SELECT person_key, min(matched) m FROM usage WHERE dataset_id = ? AND platform = 'openai' GROUP BY person_key").all(ds.id);
  assert.equal(matched.find((x) => x.person_key === 'openai:unattributed').m, 0);
  const det = db.prepare("SELECT count(DISTINCT product) p FROM vendor_usage_detail WHERE vendor = 'openai'").get();
  assert.equal(det.p, 2);
});
