'use strict';
// Vendor connector framework and the Anthropic Enterprise connector (CONTRACT section 16.1, 16.2, 16.6)
// against a fake Anthropic server that enforces the documented constraints: beta header, limit paging
// with next_page, starting_at >= 2026-01-01, span <= 31 days, a 410 on an expired cursor, a 429,
// x-api-key, data_refreshed_at, rbac_groups and members, and an unbucketed no-group_by cost total.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setup, teardown, startApp } = require('./helpers');

const GOOD_KEY = 'sk-ant-api01-GOOD-key-0123456789';
const BAD_KEY = 'sk-ant-api01-BAD-key-9876543210';
process.env.AIXP_SECRET_KEY = 'b2'.repeat(32);

const ctx = setup();
const db = ctx.db.getDb();
const { seedFixture } = require('./seed');
const client = require('../src/services/connectors/anthropicClient');
const anthropic = require('../src/services/connectors/anthropic');
const connectors = require('../src/services/connectors');
const win = require('../src/services/connectors/window');
const imp = require('../src/services/vendorImport');
const vendorSchedule = require('../src/services/vendorSchedule');
const powerbiImp = require('../src/services/powerbiImport');
const importLock = require('../src/services/importLock');
const settings = require('../src/services/settings');
const datasets = require('../src/services/datasets');
const time = require('../src/services/time');
const auth = require('../src/auth');

const NOW = '2026-11-04T08:30:00Z';
const DATA_FIRST = '2026-08-01';
const DATA_LAST = '2026-10-30';
const T = { v: Date.parse(NOW) }; // fake clock for the client pacer
const sleeps = [];

// ---- fake Anthropic ---------------------------------------------------------------------

const fake = {
  base: '', server: null, calls: [], used: new Set(), expireOnce: false, throttle: 0, delay: 0, leakNull: true,
  groupsForbidden: false, pageCap: 400, refreshed: null, rows: [], users: [], hits403: 0,
};

const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1'];
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const cents = (n) => n.toFixed(6);

function genRows(people) {
  // Eight users are in People (alias key, e-mail like the fixture); the ninth has an e-mail no People row carries.
  const users = people.slice(0, 9).map((p, i) => ({
    user_id: `user_${String(i + 1).padStart(3, '0')}`, email_address: i < 8 ? p.email.toLowerCase() : 'unknown.person@nowhere.example',
    name: p.display_name, deleted: false, key: i < 8 ? p.person_key : 'unknown.person@nowhere.example',
  }));
  users.push({ user_id: 'user_del1', email_address: null, name: null, deleted: true });
  const rows = [];
  const days = [];
  for (let ms = dayMs(DATA_FIRST); ms <= dayMs(DATA_LAST); ms += 86400000) days.push(new Date(ms).toISOString().slice(0, 10));
  days.forEach((day, d) => {
    users.forEach((u, i) => {
      if (u.deleted) { if (d % 10 !== 0) return; } else if ((i + d) % 3 === 0) return;
      const models = i % 2 === 0 ? MODELS : [MODELS[0]];
      models.forEach((model, mi) => {
        ['chat', 'claude_code'].forEach((product, pi) => {
          const tokens = 1000 + ((i * 7919 + d * 104729 + mi * 31 + pi * 17) % 5000) * 10;
          // one user spells a product with a hyphen on some days; the connector must normalise it
          const prod = i === 3 && product === 'chat' && d % 5 === 0 ? 'claude-tag' : product;
          const m = i === 2 && d === 45 && product === 'chat' && mi === 0 ? null : model;
          const c = tokens * 0.0012 * (u.deleted ? 0.001 : 1);
          rows.push({ day, user: u, model: m, product: prod, tokens, cents: c, listCents: c * 1.2, requests: 3 + ((i + d) % 9) });
        });
      });
    });
    if (d % 7 === 0) rows.push({ day, user: null, model: MODELS[0], product: 'other', tokens: 500, cents: 0.9, listCents: 1.1, requests: 2 });
  });
  return { users, rows };
}

const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

function actorOf(u) {
  return u ? { type: 'user_actor', user_id: u.user_id, email_address: u.email_address, name: u.name, deleted: u.deleted } : null;
}

function costRow(r, start) {
  const day = dayMs(r.day);
  return {
    starting_at: new Date(day).toISOString().replace('.000Z', 'Z'),
    ending_at: new Date(day + 86400000).toISOString().replace('.000Z', 'Z'),
    group: { actor: actorOf(r.user), model: r.model, product: r.product },
    cost: { amount: cents(r.cents), list_amount: cents(r.listCents), currency: 'USD', requests: r.requests },
  };
}
function usageRow(r) {
  const day = dayMs(r.day);
  const out = Math.round(r.tokens * 0.2);
  return {
    starting_at: new Date(day).toISOString().replace('.000Z', 'Z'),
    ending_at: new Date(day + 86400000).toISOString().replace('.000Z', 'Z'),
    group: { actor: actorOf(r.user), model: r.model, product: r.product },
    usage: {
      uncached_input_tokens: r.tokens - out, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      cache_read_input_tokens: 0, output_tokens: out, total_tokens: r.tokens, requests: r.requests,
    },
  };
}

function apiErr(res, status, message, type) {
  return res.status(status).json({ type: 'error', error: { type: type || 'invalid_request_error', message } });
}

function buildFake() {
  const app = express();
  app.use((req, res, next) => {
    const entry = { path: req.path, t: T.v, beta: req.headers['anthropic-beta'], version: req.headers['anthropic-version'], q: req.query, key: req.headers['x-api-key'] };
    fake.calls.push(entry);
    if (req.headers['x-api-key'] !== GOOD_KEY) return apiErr(res, 401, 'invalid x-api-key', 'authentication_error');
    return next();
  });
  const analytics = async (kind, req, res) => {
    if (req.headers['anthropic-beta'] !== 'analytics-usage-cost-2026-08-24') return apiErr(res, 400, 'anthropic-beta header analytics-usage-cost-2026-08-24 is required');
    if (fake.delay) await new Promise((r) => setTimeout(r, fake.delay));
    if (fake.throttle > 0) {
      fake.throttle -= 1;
      res.set('Retry-After', '2');
      return apiErr(res, 429, 'rate limit exceeded', 'rate_limit_error');
    }
    const q = req.query;
    const start = Date.parse(q.starting_at);
    const end = Date.parse(q.ending_at);
    if (!q.starting_at || Number.isNaN(start)) return apiErr(res, 400, 'starting_at is required (RFC 3339)');
    if (start < Date.parse('2026-01-01T00:00:00Z')) return apiErr(res, 400, 'starting_at must be on or after 2026-01-01');
    if (Number.isNaN(end) || end <= start) return apiErr(res, 400, 'ending_at must be after starting_at');
    if (end - start > 31 * 86400000) return apiErr(res, 400, 'the span between starting_at and ending_at is at most 31 days');
    fake.calls[fake.calls.length - 1].start = start;
    fake.calls[fake.calls.length - 1].end = end;
    fake.calls[fake.calls.length - 1].kind = kind;
    const inWin = fake.rows.filter((r) => dayMs(r.day) >= start && dayMs(r.day) < end);
    fake.refreshed = fake.refreshed || new Date(Date.now() - 3 * 3600000).toISOString();
    const groupBy = [].concat(q.group_by || []);
    if (!q.time_bucket_width) {
      // unbucketed: whole range. No group_by = the organization total in one row.
      if (groupBy.length) return apiErr(res, 400, 'this fake only serves the unbucketed total without group_by');
      const total = {
        starting_at: q.starting_at, ending_at: q.ending_at, group: null,
        cost: { amount: cents(sum(inWin, (r) => r.cents)), list_amount: cents(sum(inWin, (r) => r.listCents)), currency: 'USD', requests: null },
      };
      return res.json({ data: [total], has_more: false, next_page: null, data_refreshed_at: fake.refreshed });
    }
    if (q.time_bucket_width !== '1d') return apiErr(res, 400, 'only 1d buckets are served here');
    const actorTypes = [].concat(q.actor_types || []);
    let rows = inWin;
    if (actorTypes.length && !fake.leakNull) rows = rows.filter((r) => r.user);
    rows = rows.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const limit = Math.min(fake.pageCap, 1000, Number(q.limit) || 20);
    const sig = JSON.stringify(Object.assign({ kind }, q, { page: undefined }));
    let offset = 0;
    if (q.page) {
      let cur;
      try { cur = JSON.parse(Buffer.from(String(q.page), 'base64url').toString('utf8')); } catch (e) { return apiErr(res, 400, 'invalid page cursor'); }
      if (cur.sig !== sig) return apiErr(res, 400, 'the page cursor does not match the other parameters');
      if (fake.expireOnce || fake.used.has(q.page)) {
        fake.expireOnce = false;
        return apiErr(res, 410, 'the page cursor expired after a data refresh');
      }
      fake.used.add(q.page);
      offset = cur.o;
    }
    const slice = rows.slice(offset, offset + limit);
    const hasMore = offset + limit < rows.length;
    const next = hasMore ? Buffer.from(JSON.stringify({ o: offset + limit, sig })).toString('base64url') : null;
    return res.json({
      data: slice.map((r) => (kind === 'cost' ? costRow(r) : usageRow(r))),
      has_more: hasMore, next_page: next, data_refreshed_at: fake.refreshed,
    });
  };
  app.get('/v1/organizations/analytics/cost', (req, res) => analytics('cost', req, res));
  app.get('/v1/organizations/analytics/usage', (req, res) => analytics('usage', req, res));
  app.get('/v1/organizations/rbac_groups', (req, res) => {
    if (fake.groupsForbidden) { fake.hits403 += 1; return apiErr(res, 403, 'the key lacks the read:rbac_groups scope', 'permission_error'); }
    return res.json({ data: [{ id: 'rbacgrp_1', name: 'Technology - Dept', source_type: 'scim' }, { id: 'rbacgrp_2', name: 'Finance', source_type: 'direct' }], has_more: false, next_page: null });
  });
  app.get('/v1/organizations/rbac_groups/:id/members', (req, res) => {
    const u = fake.users.filter((x) => !x.deleted);
    if (req.params.id === 'rbacgrp_1') {
      return res.json({ data: u.slice(0, 4).map((x) => ({ user_id: x.user_id, email_address: x.email_address, name: x.name })), has_more: false, next_page: null });
    }
    const list = u.slice(3, 6).map((x) => ({ user_id: x.user_id, email_address: x.email_address, name: x.name }));
    list.push({ user: { id: 'user_zzz', name: 'Id Only' } }); // a member that carries only an id
    return res.json({ data: list, has_more: false, next_page: null });
  });
  return app;
}

// ---- helpers ----------------------------------------------------------------------------

let app;
let anon;
let fakeServer;
let admin;
let baseId;
let baseCounts;
const put = (patch) => admin.call('PUT', '/api/settings', { patch });
const platformCounts = (id) => Object.fromEntries(db.prepare('SELECT platform, count(*) n FROM usage WHERE dataset_id = ? GROUP BY platform').all(id).map((r) => [r.platform, r.n]));

async function configure(extra) {
  const r = await put(Object.assign({
    'anthropic.enabled': true, 'anthropic.api_key': GOOD_KEY, 'anthropic.base_url': fake.base + '/', 'vendors.months_back': 2,
  }, extra || {}));
  assert.equal(r.status, 200, r.text);
}

function resetFake() {
  fake.calls.length = 0; fake.used.clear(); fake.expireOnce = false; fake.throttle = 0; fake.delay = 0; fake.leakNull = true;
  fake.groupsForbidden = false; fake.hits403 = 0;
  sleeps.length = 0;
  client.resetStats();
  client.resetPacer();
}

const analyticsCalls = () => fake.calls.filter((c) => c.kind);

test.before(async () => {
  seedFixture({ months: 3, people: 120, profile: 'clean', endDate: DATA_LAST, label: 'baseline fixture' });
  baseId = datasets.active().id;
  baseCounts = platformCounts(baseId);
  const people = db.prepare('SELECT person_key, email, display_name FROM people WHERE dataset_id = ? ORDER BY person_key LIMIT 9').all(baseId);
  const gen = genRows(people);
  fake.rows = gen.rows;
  fake.users = gen.users;
  fakeServer = buildFake().listen(0);
  await new Promise((r) => fakeServer.once('listening', r));
  fake.base = `http://127.0.0.1:${fakeServer.address().port}`;
  client.setClock(() => T.v);
  client.setSleep(async (ms) => { sleeps.push(ms); T.v += ms; });
  client.setBackoff(5);
  time.setNow(NOW);
  app = await startApp();
  anon = app.call;
  admin = await app.admin();
  app.call = admin.call;
});
test.after(async () => {
  time.setNow(null);
  vendorSchedule.stop();
  client.setClock(null);
  client.setSleep(null);
  client.setBackoff(null);
  if (app) await app.close();
  await new Promise((r) => fakeServer.close(r));
  teardown(ctx);
});
test.beforeEach(() => resetFake());

// ---- settings, rules, registry ------------------------------------------------------------

test('settings: validators, trailing slash, masked and encrypted api key', async () => {
  assert.equal((await put({ 'anthropic.base_url': 'https://proxy.example.com/' })).status, 200);
  assert.equal(settings.get('anthropic.base_url'), 'https://proxy.example.com');
  assert.equal((await put({ 'anthropic.base_url': 'ftp://nope' })).status, 400);
  assert.equal((await put({ 'anthropic.base_url': 'not a url' })).status, 400);
  assert.equal((await put({ 'anthropic.rebuild_days': 0 })).status, 400);
  assert.equal((await put({ 'anthropic.rebuild_days': 32 })).status, 400);
  assert.equal((await put({ 'anthropic.rebuild_days': 9 })).status, 200);
  assert.equal((await put({ 'vendors.schedule': '25:00' })).status, 400);
  assert.equal((await put({ 'vendors.schedule': '' })).status, 200);
  assert.equal((await put({ 'vendors.months_back': 0 })).status, 400);
  assert.equal((await put({ 'anthropic.history_floor': 'soon' })).status, 400);
  const r = await put({ 'anthropic.api_key': GOOD_KEY });
  assert.deepEqual(r.json['anthropic.api_key'], { set: true });
  assert.ok(!r.text.includes(GOOD_KEY));
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'anthropic.api_key'").get().value;
  assert.ok(stored.startsWith('"enc:v1:'), 'stored encrypted');
  assert.ok(!stored.includes(GOOD_KEY));
  assert.equal(settings.getSecret('anthropic.api_key'), GOOD_KEY);
  const keep = await put({ 'anthropic.api_key': { set: true } });
  assert.equal(keep.status, 200);
  assert.equal(settings.getSecret('anthropic.api_key'), GOOD_KEY, 'the masked object keeps the key');
  await put({ 'anthropic.api_key': null });
  assert.equal(settings.getSecret('anthropic.api_key'), '');
  const defaults = (await admin.call('GET', '/api/settings')).json;
  assert.equal(defaults['anthropic.anthropic_version'], '2026-10-21');
  assert.equal(defaults['anthropic.history_floor'], '2026-01-01');
  assert.equal(defaults['vendors.auto_promote'], true);
});

test('auth rules: detail needs people.view, the rest of /vendors needs data.manage', () => {
  assert.deepEqual(auth.requiredFor('GET', '/vendors/detail'), ['people.view']);
  assert.deepEqual(auth.requiredFor('GET', '/vendors'), ['data.manage']);
  assert.deepEqual(auth.requiredFor('POST', '/vendors/pull'), ['data.manage']);
  assert.deepEqual(auth.requiredFor('POST', '/vendors/anthropic/test'), ['data.manage']);
});

test('registry lists the connector with problems, enabled and describe()', async () => {
  const l = connectors.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].id, 'anthropic');
  assert.equal(l[0].platform, 'anthropic');
  assert.equal(l[0].enabled, false);
  assert.equal(l[0].configured, false);
  assert.deepEqual(l[0].problems, ['api key']);
  assert.equal(l[0].describe.history_floor, '2026-01-01');
  const r = await app.call('GET', '/api/vendors');
  assert.equal(r.status, 200);
  assert.equal(r.json.connectors[0].id, 'anthropic');
  assert.equal(r.json.running, false);
  assert.equal(r.json.next_run_at, null);
  for (const k of ['schedule', 'auto_promote', 'months_back', 'last_pull_at', 'last_pull']) assert.ok(k in r.json, k);
});

// ---- test() ---------------------------------------------------------------------------------

test('test(): a missing key fails the first step with the reason and never throws', async () => {
  assert.deepEqual(anthropic.problems(), ['api key']);
  const t = await anthropic.test();
  assert.equal(t.ok, false);
  assert.deepEqual(t.steps.map((s) => s.key), ['auth', 'cost', 'usage', 'groups', 'freshness', 'floor']);
  assert.equal(t.steps[0].ok, false);
  assert.match(t.steps[0].detail, /Not configured: api key/);
  assert.ok(t.steps.slice(1).every((s) => s.ok === false && /Not checked/.test(s.detail)));
  const r = await app.call('POST', '/api/vendors/anthropic/test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal((await app.call('POST', '/api/vendors/nope/test')).status, 404);
  assert.equal(fake.calls.length, 0, 'no request without a key');
});

test('test(): a refused key quotes the vendor error and hides the key', async () => {
  await configure({ 'anthropic.api_key': BAD_KEY });
  const r = await app.call('POST', '/api/vendors/anthropic/test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.steps[0].key, 'auth');
  assert.match(r.json.steps[0].detail, /HTTP 401/);
  assert.match(r.json.steps[0].detail, /invalid x-api-key/);
  assert.ok(!r.text.includes(BAD_KEY));
  assert.ok(r.json.steps.slice(1).every((s) => /Not checked/.test(s.detail)));
});

test('test(): a good key passes every step; a missing groups scope is reported, not failed', async () => {
  await configure();
  let r = await app.call('POST', '/api/vendors/anthropic/test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, r.text);
  assert.deepEqual(r.json.steps.map((s) => s.key), ['auth', 'cost', 'usage', 'groups', 'freshness', 'floor']);
  assert.match(r.json.steps[1].detail, /cost rows for yesterday/);
  assert.match(r.json.steps[3].detail, /2 groups/);
  assert.match(r.json.steps[5].detail, /available from 2026-01-01/);
  assert.ok(analyticsCalls().every((c) => c.beta === 'analytics-usage-cost-2026-08-24'));
  assert.ok(analyticsCalls().every((c) => c.version === '2026-10-21'));
  resetFake();
  fake.groupsForbidden = true;
  r = await app.call('POST', '/api/vendors/anthropic/test');
  assert.equal(r.json.ok, true);
  assert.match(r.json.steps[3].detail, /read:rbac_groups not granted, org mapping skipped/);
  assert.equal(fake.hits403, 1);
});

// ---- pull() on its own ----------------------------------------------------------------------

test('pull(): slices of at most 31 days, paced at 1,000 ms, retries a 429 and restarts an expired cursor', async () => {
  await configure();
  fake.throttle = 1;
  fake.expireOnce = true;
  const from = '2026-09-01';
  const to = '2026-11-04T08:00:00.000Z';
  const logs = [];
  const progress = [];
  const r = await anthropic.pull({ from, to, log: (m) => logs.push(m), progress: (s, e) => progress.push([s, e]) });
  // slicing: 2026-09-01 .. 2026-11-04T08:00 = 64 days + 8 h -> 3 slices, each at most 31 days, contiguous
  const windows = [...new Map(analyticsCalls().map((c) => [`${c.start}-${c.end}`, c])).values()].sort((a, b) => a.start - b.start);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].start, dayMs('2026-09-01'));
  windows.forEach((w, i) => {
    assert.ok(w.end - w.start <= 31 * 86400000);
    if (i > 0) assert.equal(w.start, windows[i - 1].end);
  });
  assert.equal(windows[2].end, Date.parse(to));
  // pacing: every request, retries included, at least 1,000 ms after the previous one on the fake clock
  assert.ok(fake.calls.length > 9);
  for (let i = 1; i < fake.calls.length; i++) assert.ok(fake.calls[i].t - fake.calls[i - 1].t >= 1000, `gap ${i}: ${fake.calls[i].t - fake.calls[i - 1].t}`);
  // the 429 honoured Retry-After (2 s), the 410 restarted that window once
  assert.equal(client.stats.retries, 1);
  assert.ok(sleeps.includes(2000), `sleeps ${sleeps}`);
  assert.equal(client.stats.restarts, 1);
  // paging: limit 1000 and next_page were used
  assert.ok(analyticsCalls().some((c) => c.q.page));
  assert.ok(analyticsCalls().every((c) => c.q.limit === '1000' || !c.q.time_bucket_width));
  assert.deepEqual([].concat(analyticsCalls()[0].q.group_by), ['actor', 'model', 'product']);
  assert.deepEqual([].concat(analyticsCalls()[0].q.actor_types), ['user_actor']);

  // join and sums
  const inWin = fake.rows.filter((x) => x.day >= from);
  const attributed = inWin.filter((x) => x.user);
  assert.ok(Math.abs(sum(r.usage, (u) => u.CostUSD) - sum(inWin, (x) => x.cents) / 100) < 1e-6, 'CostUSD sums to amounts / 100');
  assert.equal(sum(r.usage, (u) => u.Tokens), sum(inWin, (x) => x.tokens));
  assert.equal(sum(r.usage, (u) => u.Requests), sum(inWin, (x) => x.requests));
  assert.ok(Math.abs(sum(r.usage, (u) => u.ListCostUSD) - sum(inWin, (x) => x.listCents) / 100) < 1e-6);
  assert.ok(Math.abs(sum(r.detail, (u) => u.cost_usd) - sum(inWin, (x) => x.cents) / 100) < 1e-6);
  // products are summed into the usage grain: no duplicate (Date, PersonKey, Platform, Model)
  const grain = new Set(r.usage.map((u) => `${u.Date}|${u.PersonKey}|${u.Platform}|${u.Model}`));
  assert.equal(grain.size, r.usage.length);
  assert.ok(r.usage.every((u) => u.Platform === 'anthropic' && u.ConsumptionUnit === 'tokens' && u.Credits === ''));
  // rows keyed by e-mail (lowercased); deleted user falls back to user:<id>; null actor is unattributed
  const mail = fake.users[0].email_address.toLowerCase();
  assert.ok(r.usage.some((u) => u.PersonKey === mail && u.Email === mail));
  assert.ok(r.usage.some((u) => u.PersonKey === 'user:user_del1' && u.Email === ''), 'deleted user fallback key');
  assert.ok(r.usage.some((u) => u.PersonKey === 'anthropic:unattributed'), 'actor null kept as unattributed');
  assert.ok(logs.some((m) => /keyed by user id/.test(m)), 'the fallback is flagged in the log');
  assert.ok(r.usage.some((u) => u.Model === 'unattributed'), 'null model');
  // detail: one row per (date, person, model, product); claude-tag normalised to underscore
  assert.ok(r.detail.length > r.usage.length);
  assert.ok(r.detail.every((d) => d.vendor === 'anthropic'));
  assert.ok(r.detail.some((d) => d.product === 'claude_tag'));
  assert.ok(!r.detail.some((d) => d.product === 'claude-tag'));
  assert.deepEqual([...new Set(r.detail.map((d) => d.product))].sort(), ['chat', 'claude_code', 'claude_tag', 'other']);
  const key = new Set(r.detail.map((d) => `${d.date}|${d.person_key}|${d.model}|${d.product}`));
  assert.equal(key.size, r.detail.length);
  // coverage
  assert.ok(Math.abs(r.coverage.org_total_usd - sum(inWin, (x) => x.cents) / 100) < 1e-6);
  assert.ok(Math.abs(r.coverage.user_rows_usd - sum(attributed, (x) => x.cents) / 100) < 1e-6);
  assert.ok(r.coverage.user_rows_usd < r.coverage.org_total_usd);
  assert.equal(r.coverage.data_refreshed_at, fake.refreshed);
  // orgs: groups with members (the id-only member is keyed user:<id>)
  assert.deepEqual(r.orgs.values.map((v) => v.value), ['Technology - Dept', 'Finance']);
  assert.equal(r.orgs.values[0].people.length, 4);
  assert.equal(r.orgs.values[0].people[0].person_key, fake.users[0].email_address);
  assert.ok(r.orgs.values[1].people.some((p) => p.person_key === 'user:user_zzz'));
  assert.ok(progress.some(([s]) => s === 'usage') && progress.some(([s]) => s === 'people'));
});

test('pull(): a group call refused for scope skips orgs and keeps the usage', async () => {
  await configure();
  fake.groupsForbidden = true;
  const logs = [];
  const r = await anthropic.pull({ from: '2026-10-20', to: '2026-10-31T00:00:00Z', log: (m) => logs.push(m) });
  assert.deepEqual(r.orgs.values, []);
  assert.ok(r.usage.length > 0);
  assert.ok(logs.some((m) => /groups skipped: read:rbac_groups not granted/.test(m)));
});

test('pull(): a refused key throws with the vendor message and no key text', async () => {
  await configure({ 'anthropic.api_key': BAD_KEY });
  await assert.rejects(() => anthropic.pull({ from: '2026-10-20', to: '2026-10-31T00:00:00Z' }), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /invalid x-api-key/);
    assert.ok(!e.message.includes(BAD_KEY));
    return true;
  });
});

test('merge(): a null actor, a deleted user and a missing model are kept', () => {
  const day = '2026-10-01T00:00:00Z';
  const row = (actor, model, product, amount) => ({ starting_at: day, ending_at: '2026-10-02T00:00:00Z', group: { actor, model, product }, cost: { amount, list_amount: amount } });
  const urow = (actor, model, product, tokens) => ({ starting_at: day, group: { actor, model, product }, usage: { total_tokens: tokens, requests: 1 } });
  const A = { type: 'user_actor', user_id: 'user_a', email_address: ' Ann.Lee@Corp.Example ' };
  const m = anthropic.merge(
    [row(A, 'm1', 'chat', '100.5'), row(A, 'm1', 'claude-code', '50'), row(null, null, null, '20'), row({ type: 'user_actor', user_id: 'user_x', email_address: null, deleted: true }, 'm1', 'chat', '10')],
    [urow(A, 'm1', 'chat', 10), urow(A, 'm1', 'claude-code', 5), urow(null, null, null, 2)]
  );
  assert.equal(m.usage.length, 3);
  const ann = m.usage.find((u) => u.PersonKey === 'ann.lee@corp.example');
  assert.equal(ann.Tokens, 15);
  assert.equal(ann.CostUSD, 1.505);
  assert.equal(ann.Requests, 2);
  assert.ok(m.usage.some((u) => u.PersonKey === 'user:user_x'));
  const un = m.usage.find((u) => u.PersonKey === 'anthropic:unattributed');
  assert.equal(un.Model, 'unattributed');
  assert.equal(m.detail.length, 4);
  assert.ok(m.detail.some((d) => d.product === 'claude_code'));
  assert.equal(m.user_rows_usd, (100.5 + 50 + 10) / 100);
});

// ---- window arithmetic ----------------------------------------------------------------------

test('window: full pull starts at the month months_back ago, an incremental one at last day minus rebuild days', () => {
  const base = { floor: '2026-01-01', monthsBack: 13, rebuildDays: 9, maxDaysBack: 365, today: '2026-11-04' };
  assert.equal(win.planFrom({ ...base, lastDay: null }), '2026-01-01', 'floor wins over 13 months');
  assert.equal(win.planFrom({ ...base, monthsBack: 2, lastDay: null }), '2026-09-01');
  assert.equal(win.planFrom({ ...base, lastDay: '2026-10-30' }), '2026-10-21');
  assert.equal(win.planFrom({ ...base, lastDay: '2026-01-03' }), '2026-01-01', 'never before the floor');
  assert.equal(win.planFrom({ ...base, floor: '2025-01-01', monthsBack: 60, lastDay: null }), '2025-11-05', 'within 365 days');
  const s = win.slices('2026-09-01', '2026-11-04T08:00:00.000Z');
  assert.equal(s.length, 3);
  assert.equal(win.endNow('2026-11-04T08:30:12Z'), '2026-11-04T08:00:00.000Z');
});

// ---- end to end ---------------------------------------------------------------------------------

let firstPull;
let firstSum;

test('pull to a dataset: carry-over, matching, verdict, promote, detail rows, last pull', async () => {
  await configure();
  assert.equal(datasets.active().id, baseId);
  const events = [];
  const sse = require('../src/services/events');
  sse.addClient({ on() {} }, { writeHead() {}, flushHeaders() {}, write(s) { events.push(...String(s).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'import.progress')); } });

  const r = await app.call('POST', '/api/vendors/pull', {});
  assert.equal(r.status, 200, r.text);
  firstPull = r.json;
  assert.notEqual(r.json.verdict, 'fail');
  assert.equal(r.json.promoted, true);
  assert.ok(r.json.rows > 0 && r.json.duration_ms >= 0);
  assert.equal(r.json.by_vendor.anthropic.from, '2026-09-01');
  assert.equal(r.json.by_vendor.anthropic.to, '2026-11-04');
  assert.ok(r.json.by_vendor.anthropic.coverage.pct > 90);
  assert.equal(r.json.by_vendor.anthropic.data_refreshed_at, fake.refreshed);

  const ds = datasets.active();
  assert.equal(ds.id, r.json.dataset_id);
  assert.equal(ds.provider, 'vendor');
  assert.equal(ds.source, 'import');
  assert.deepEqual(ds.options.connectors, ['anthropic']);
  assert.equal(ds.options.asOf, DATA_LAST);
  assert.equal(datasets.get(baseId).status, 'archived');

  // carry-over: github, openai and cowork rows equal the fixture's
  const counts = platformCounts(ds.id);
  for (const p of ['github', 'openai', 'cowork']) assert.equal(counts[p], baseCounts[p], `${p} rows carried over`);
  // anthropic rows are the connector's, not the fixture's
  const inWin = fake.rows.filter((x) => x.day >= '2026-09-01');
  firstSum = db.prepare("SELECT sum(cost_usd) c, sum(tokens) t FROM usage WHERE dataset_id = ? AND platform = 'anthropic'").get(ds.id);
  assert.ok(Math.abs(firstSum.c - sum(inWin, (x) => x.cents) / 100) < 1e-6);
  assert.equal(firstSum.t, sum(inWin, (x) => x.tokens));
  assert.equal(db.prepare("SELECT min(date) d FROM usage WHERE dataset_id = ? AND platform = 'anthropic'").get(ds.id).d >= '2026-09-01', true);
  // matching: eight users resolve to their alias key; the unknown e-mail stays keyed by e-mail, unmatched
  const matched = db.prepare("SELECT person_key, min(matched) m FROM usage WHERE dataset_id = ? AND platform = 'anthropic' GROUP BY person_key").all(ds.id);
  const aliasKeys = fake.users.filter((u) => u.key && !u.deleted).slice(0, 8).map((u) => u.key);
  for (const k of aliasKeys) assert.equal(matched.find((x) => x.person_key === k).m, 1, `${k} matched under its alias`);
  assert.ok(!matched.some((x) => x.person_key === fake.users[0].email_address), 'resolved e-mail is not a key');
  assert.equal(matched.find((x) => x.person_key === 'unknown.person@nowhere.example').m, 0, 'unknown e-mail lands in Unmatched keyed by e-mail');
  assert.match(db.prepare("SELECT email FROM stage_usage WHERE dataset_id = ? AND person_key = ? LIMIT 1").get(ds.id, aliasKeys[0]).email, /@/, 'stage e-mail kept');
  assert.equal(matched.find((x) => x.person_key === 'user:user_del1').m, 0);
  assert.equal(matched.find((x) => x.person_key === 'anthropic:unattributed').m, 0);
  // extra column and email reached staging
  const st = db.prepare("SELECT extra_json, email FROM stage_usage WHERE dataset_id = ? AND platform = 'anthropic' LIMIT 1").get(ds.id);
  assert.ok('ListCostUSD' in JSON.parse(st.extra_json));
  assert.match(st.email, /@/);
  // the detail table carries the product breakdown
  const det = db.prepare("SELECT count(*) n, count(DISTINCT product) p, sum(cost_usd) c FROM vendor_usage_detail WHERE vendor = 'anthropic'").get();
  assert.ok(det.n > counts.anthropic);
  assert.equal(det.p, 4);
  assert.ok(Math.abs(det.c - firstSum.c) < 1e-6);
  // coverage check ran on the vendor dataset
  const cov = db.prepare(
    `SELECT r.* FROM verification_results r JOIN verification_runs v ON v.id = r.run_id WHERE v.dataset_id = ? AND r.check_id = 'vendor_coverage'`
  ).all(ds.id);
  assert.equal(cov.length, 1);
  assert.equal(cov[0].platform, 'anthropic');
  assert.equal(cov[0].status, 'pass');
  assert.match(cov[0].message, /User-attributed rows cover \d+(\.\d+)?% of the organization total/);
  assert.ok(JSON.parse(cov[0].evidence_json).rows.length === 1);
  // the check skips datasets that were not loaded by a vendor pull
  const baseCov = db.prepare(
    `SELECT r.status FROM verification_results r JOIN verification_runs v ON v.id = r.run_id WHERE v.dataset_id = ? AND r.check_id = 'vendor_coverage'`
  ).all(baseId);
  assert.ok(baseCov.every((x) => x.status === 'skip'));
  // last pull and progress events
  const st2 = (await app.call('GET', '/api/vendors')).json;
  assert.equal(st2.last_pull.dataset_id, ds.id);
  assert.equal(st2.last_pull.error, null);
  assert.equal(st2.last_pull.by_vendor.anthropic.rows, r.json.by_vendor.anthropic.rows);
  assert.ok(st2.last_pull_at);
  const stages = events.map((e) => e.stage);
  for (const s of ['auth', 'usage', 'carry', 'people', 'lookups', 'normalize', 'verify', 'promote', 'done']) assert.ok(stages.includes(s), `stage ${s}`);
  assert.ok(events.filter((e) => e.stage === 'usage').every((e) => e.vendor === 'anthropic'));
  assert.equal(events[events.length - 1].stage, 'done');
});

test('a second pull reads only the trailing window and gives the same totals', async () => {
  const prev = datasets.active();
  assert.equal(prev.id, firstPull.dataset_id);
  resetFake();
  const r = await app.call('POST', '/api/vendors/pull', { ids: ['anthropic'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.by_vendor.anthropic.from, '2026-10-21', 'last pulled day 2026-10-30 minus 9 rebuild days');
  const starts = analyticsCalls().map((c) => c.start);
  assert.ok(Math.min(...starts) === dayMs('2026-10-21'));
  assert.equal(new Set(analyticsCalls().map((c) => `${c.start}-${c.end}`)).size, 1, 'one slice');
  const ds = datasets.active();
  assert.notEqual(ds.id, prev.id);
  const now = db.prepare("SELECT sum(cost_usd) c, sum(tokens) t, count(*) n FROM usage WHERE dataset_id = ? AND platform = 'anthropic'").get(ds.id);
  assert.ok(Math.abs(now.c - firstSum.c) < 1e-6, 'same cost total');
  assert.equal(now.t, firstSum.t);
  assert.equal(now.n, platformCounts(prev.id).anthropic);
  const counts = platformCounts(ds.id);
  for (const p of ['github', 'openai', 'cowork']) assert.equal(counts[p], baseCounts[p]);
  // a revised value inside the window replaces the old day; the days before it are kept
  const row = fake.rows.find((x) => x.day === '2026-10-25' && x.user && !x.user.deleted);
  row.cents += 100;
  resetFake();
  const r3 = await app.call('POST', '/api/vendors/pull', {});
  assert.equal(r3.status, 200, r3.text);
  const ds3 = datasets.active();
  const c3 = db.prepare("SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND platform = 'anthropic'").get(ds3.id).c;
  assert.ok(Math.abs(c3 - (firstSum.c + 1)) < 1e-6, 'the revision lands once');
  row.cents -= 100;
  const det = db.prepare("SELECT count(*) n FROM vendor_usage_detail WHERE vendor = 'anthropic'").get().n;
  const keys = db.prepare("SELECT count(*) n FROM (SELECT DISTINCT date, person_key, model, product FROM vendor_usage_detail WHERE vendor = 'anthropic')").get().n;
  assert.equal(det, keys, 'upserts never duplicate');
});

test('a second pull while one runs answers 409, for both importers', async () => {
  fake.delay = 300;
  const first = app.call('POST', '/api/vendors/pull', {});
  for (let i = 0; i < 100 && !imp.isRunning(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(imp.isRunning(), true);
  assert.equal(powerbiImp.isRunning(), true, 'the lock is shared');
  assert.equal((await app.call('GET', '/api/vendors')).json.running, true);
  const second = await app.call('POST', '/api/vendors/pull', {});
  assert.equal(second.status, 409);
  assert.match(second.json.error, /vendor pull is already running/);
  const pbi = await app.call('POST', '/api/powerbi/pull', {});
  assert.equal(pbi.status, 409);
  assert.match(pbi.json.error, /vendor pull is already running/);
  const done = await first;
  assert.equal(done.status, 200, done.text);
  assert.equal(imp.isRunning(), false);
  assert.equal(importLock.isBusy(), false);
});

test('a failing connector marks the dataset failed, names the vendor and leaves the active dataset alone', async () => {
  const before = datasets.active().id;
  await put({ 'anthropic.api_key': BAD_KEY });
  const r = await app.call('POST', '/api/vendors/pull', {});
  assert.equal(r.status, 502, r.text);
  assert.match(r.json.error, /Anthropic Claude Enterprise: Anthropic refused the key \(HTTP 401\): invalid x-api-key/);
  assert.ok(!r.text.includes(BAD_KEY));
  const failed = db.prepare("SELECT * FROM datasets WHERE status = 'failed' ORDER BY id DESC").get();
  assert.ok(failed);
  assert.match(failed.note, /Anthropic Claude Enterprise/);
  assert.equal(datasets.active().id, before, 'no partial promote');
  const lp = (await app.call('GET', '/api/vendors')).json.last_pull;
  assert.match(lp.error, /invalid x-api-key/);
  assert.equal(lp.verdict, null);
  assert.equal(imp.isRunning(), false);
  await put({ 'anthropic.api_key': GOOD_KEY });
});

test('pull validation: nothing enabled, unknown id, not enabled id, missing key', async () => {
  await put({ 'anthropic.enabled': false });
  let r = await app.call('POST', '/api/vendors/pull', {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /No vendor connector is enabled/);
  await put({ 'anthropic.enabled': true });
  r = await app.call('POST', '/api/vendors/pull', { ids: ['nope'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Unknown connector/);
  r = await app.call('POST', '/api/vendors/pull', { ids: 'anthropic' });
  assert.equal(r.status, 400);
  await put({ 'anthropic.api_key': null });
  r = await app.call('POST', '/api/vendors/pull', {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not configured: api key/);
  await put({ 'anthropic.api_key': GOOD_KEY });
  assert.equal(importLock.isBusy(), false);
});

// ---- detail route: permission and scope --------------------------------------------------------

test('GET /vendors/detail: people.view, filters, and a scoped caller sees only their LOB', async () => {
  const unauth = await anon('GET', '/api/vendors/detail?vendor=anthropic');
  assert.equal(unauth.status, 401);
  const all = await app.call('GET', '/api/vendors/detail?vendor=anthropic');
  assert.equal(all.status, 200);
  assert.ok(all.json.rows.length > 100);
  assert.equal(all.json.truncated, false);
  const r0 = all.json.rows[0];
  for (const k of ['vendor', 'date', 'person_key', 'email', 'model', 'product', 'tokens', 'cost_usd', 'list_cost_usd', 'requests', 'pulled_at']) assert.ok(k in r0, k);
  const mail = fake.users[0].key;
  const f = await app.call('GET', `/api/vendors/detail?vendor=anthropic&person_key=${encodeURIComponent(mail)}&product=claude_code&from=2026-10-01&to=2026-10-31`);
  assert.equal(f.status, 200);
  assert.ok(f.json.rows.length > 0);
  assert.ok(f.json.rows.every((x) => x.person_key === mail && x.product === 'claude_code' && x.date >= '2026-10-01' && x.date <= '2026-10-31'));
  assert.equal((await app.call('GET', '/api/vendors/detail?vendor=nope')).status, 400);
  assert.equal((await app.call('GET', '/api/vendors/detail?from=yesterday')).status, 400);

  // LOB split: three fake users in LOB A, the rest in LOB B
  const id = datasets.active().id;
  const A = 'Detail LOB A';
  const B = 'Detail LOB B';
  const mails = fake.users.filter((u) => !u.deleted).map((u) => u.key);
  const setLob = db.prepare('UPDATE people SET lob_cg = ?, lob_cg_sort = ? WHERE dataset_id = ? AND person_key = ?');
  mails.forEach((m, i) => (i < 3 ? setLob.run(A, 90, id, m) : setLob.run(B, 91, id, m)));
  const PW = 'Detail-Scope-12345';
  const role = await app.call('POST', '/api/access/roles', { name: 'Detail reader', description: 'test', permissions: ['dashboard.view', 'people.view'] });
  assert.equal(role.status, 201, role.text);
  const viewer = await app.call('POST', '/api/access/roles', { name: 'Plain viewer', description: 'test', permissions: ['dashboard.view'] });
  const u = await app.call('POST', '/api/access/users', { username: 'detail.a', password: PW, role_ids: [role.json.id], lob_cg: [A] });
  assert.equal(u.status, 201, u.text);
  const v = await app.call('POST', '/api/access/users', { username: 'detail.v', password: PW, role_ids: [viewer.json.id] });
  assert.equal(v.status, 201, v.text);
  const scoped = await app.login('detail.a', PW);
  const sr = await scoped.call('GET', '/api/vendors/detail?vendor=anthropic');
  assert.equal(sr.status, 200, sr.text);
  assert.ok(sr.json.rows.length > 0);
  assert.ok(sr.json.rows.every((x) => mails.slice(0, 3).includes(x.person_key)), 'only LOB A people');
  assert.ok(sr.json.rows.length < all.json.rows.length);
  const noView = await (await app.login('detail.v', PW)).call('GET', '/api/vendors/detail?vendor=anthropic');
  assert.equal(noView.status, 403);
  assert.equal(noView.json.required, 'people.view');
  assert.equal((await scoped.call('GET', '/api/vendors')).status, 403, 'data.manage is separate');
});

// ---- schedule -------------------------------------------------------------------------------------

test('vendor schedule: due only when a connector is enabled and a time is set; ticks once a day', async () => {
  await put({ 'vendors.schedule': '' });
  assert.equal(vendorSchedule.due(new Date('2026-11-04T15:00:00Z')), false, 'no schedule');
  assert.equal(vendorSchedule.nextRunAt(new Date('2026-11-04T10:00:00Z')), null);
  await put({ 'vendors.schedule': '08:00' });
  await put({ 'anthropic.enabled': false });
  assert.equal(vendorSchedule.due(new Date('2026-11-04T15:00:00Z')), false, 'no connector enabled');
  await put({ 'anthropic.enabled': true });
  settings.set('vendors.last_pull_at', null);
  assert.equal(vendorSchedule.due(new Date('2026-11-04T14:59:00Z')), false);
  assert.equal(vendorSchedule.due(new Date('2026-11-04T15:00:00Z')), true);
  assert.equal(vendorSchedule.due(new Date('2026-11-04T15:14:00Z')), true);
  assert.equal(vendorSchedule.due(new Date('2026-11-04T15:15:00Z')), false);
  assert.equal(vendorSchedule.nextRunAt(new Date('2026-11-04T10:00:00Z')), '2026-11-04T15:00:00.000Z');
  resetFake();
  const p = vendorSchedule.tick(new Date('2026-11-04T15:00:00Z'));
  assert.ok(p, 'a pull started');
  await p;
  assert.equal(vendorSchedule.due(new Date('2026-11-04T15:02:00Z')), false, 'already ran that day');
  assert.equal(vendorSchedule.tick(new Date('2026-11-04T15:03:00Z')), null);
  assert.equal(vendorSchedule.nextRunAt(new Date('2026-11-04T15:30:00Z')), '2026-11-05T15:00:00.000Z');
  const st = (await app.call('GET', '/api/vendors')).json;
  assert.ok(st.next_run_at);
  await put({ 'vendors.schedule': '' });
});

// ---- freshness with carry-over -----------------------------------------------------------------

test('freshness: platforms carried over by a vendor pull warn, pulled platforms and non-vendor datasets still fail', () => {
  const check = require('../src/services/verify/freshness_per_platform');
  const staging = require('../src/services/staging');
  const mk = (options) => {
    const id = staging.createDataset({ label: 'freshness', source: 'import', options });
    const ins = db.prepare("INSERT INTO usage (dataset_id, date, person_key, platform, model, consumption_unit, cost_usd) VALUES (?, ?, 'k', ?, '', 'tokens', 1)");
    ins.run(id, '2026-10-30', 'anthropic');
    ins.run(id, '2026-10-30', 'openai');
    ins.run(id, '2026-10-10', 'github'); // 20 days behind
    return id;
  };
  const run = (id) => check.run({ db, datasetId: id, settings: { 'verify.stale_days': 5 } });
  const gh = (out) => out.find((x) => x.platform === 'github');

  const vendorId = mk({ provider: 'vendor', connectors: ['anthropic'] });
  const v = gh(run(vendorId));
  assert.equal(v.status, 'fail');
  assert.equal(v.severity, 'warn');
  assert.match(v.message, /GitHub Copilot stopped at 2026-10-10/);
  assert.match(v.message, /carried over from the previous dataset/);
  assert.equal(run(vendorId).find((x) => x.platform === 'anthropic').status, 'pass');
  // a pulled platform keeps the fail rule
  const pulledId = mk({ provider: 'vendor', connectors: ['anthropic'] });
  db.prepare("DELETE FROM usage WHERE dataset_id = ? AND platform = 'anthropic'").run(pulledId);
  db.prepare("INSERT INTO usage (dataset_id, date, person_key, platform, model, consumption_unit, cost_usd) VALUES (?, '2026-10-01', 'k', 'anthropic', '', 'tokens', 1)").run(pulledId);
  const a = run(pulledId).find((x) => x.platform === 'anthropic');
  assert.equal(a.status, 'fail');
  assert.equal(a.severity, undefined, 'the check keeps its fail severity');
  // non-vendor dataset: unchanged
  const plain = gh(run(mk({ provider: 'powerbi' })));
  assert.equal(plain.status, 'fail');
  assert.equal(plain.severity, undefined);
  assert.doesNotMatch(plain.message, /carried over/);
  // through the engine, the carried platform moves the verdict to warn, not fail
  const eng = require('../src/services/verify');
  const out = eng.run({ db, datasetId: vendorId, prevDatasetId: null, settings: { 'verify.stale_days': 5 }, today: '2026-11-04' });
  const res = out.results.find((x) => x.check_id === 'freshness_per_platform' && x.platform === 'github');
  assert.equal(res.severity, 'warn');
  assert.notEqual(out.results.filter((x) => x.check_id === 'freshness_per_platform' && x.status === 'fail' && x.severity === 'fail').length, 1);
});
