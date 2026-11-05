'use strict';
// GitHub Copilot connector (CONTRACT section 18.3) against a fake GitHub server: users-1-day reports whose
// download links serve NDJSON from a second route (no Authorization header allowed there), billing usage for the
// enterprise and an organization (with one duplicated item), premium request usage per user, Link-paginated
// teams and members, seats, X-RateLimit headers, one 403 with Retry-After, and a 404 for a day that is not ready.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setup, teardown, startApp } = require('./helpers');

const GOOD = 'ghp_GOODtoken0123456789abcdef';
const BAD = 'ghp_BADtoken9876543210fedcba';
process.env.AIXP_SECRET_KEY = 'c3'.repeat(32);

const ctx = setup();
const db = ctx.db.getDb();
const { seedFixture } = require('./seed');
const client = require('../src/services/connectors/githubClient');
const github = require('../src/services/connectors/github');
const connectors = require('../src/services/connectors');
const imp = require('../src/services/vendorImport');
const settings = require('../src/services/settings');
const datasets = require('../src/services/datasets');
const activeCopy = require('../src/services/activeCopy');
const time = require('../src/services/time');

const NOW = '2026-11-04T08:30:00Z';
const READY_LAST = '2026-10-31'; // 11-01 and later answer 404 (not ready) unless fake.readyLast moves
const NO_BILLING = '2026-10-28';
const ZERO_CREDITS = '2026-10-30';
const T = { v: Date.parse(NOW) };
const sleeps = [];

const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const dayNo = (d) => Math.round((dayMs(d) - dayMs('2026-09-01')) / 86400000);
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} vs ${b}`);

// Logins as GitHub spells them (EMU suffix, mixed case) and the person each should resolve to.
const USERS = [
  { login: 'U2000000_capgroup', key: 'u2000000', person: null },
  { login: 'u2000001_CapGroup', key: 'u2000001', person: null },
  { login: 'wren.fischer_capgroup', key: 'wren.fischer', person: null },
  { login: 'sam.young', key: 'sam.young', person: null },
  { login: 'Stranger-Dev_capgroup', key: 'stranger-dev', person: null },
];

function creditsOf(i, d) {
  if (d === ZERO_CREDITS) return 0;
  if (i === 3 && dayNo(d) % 4 === 0) return null; // user absent that day
  return 10 + ((i * 7 + dayNo(d) * 3) % 20);
}
const grossOf = (d) => 20 + (dayNo(d) % 7);
const EXTRA_GROSS = 3; // a cost-center item only the organization call returns
const premiumOf = (login) => ({ a: 5 + (login.length % 5), b: 2.5 });

// ---- fake GitHub -------------------------------------------------------------------------

const fake = {
  base: '', readyLast: READY_LAST, calls: [], dlAuth: [], throttled: false, remaining: 4999, reset: 0, noBillingEnterprise404: false, teamsForbidden: false,
};

function ghErr(res, status, message, headers) {
  if (headers) for (const [k, v] of Object.entries(headers)) res.set(k, v);
  return res.status(status).json({ message, documentation_url: 'https://docs.github.com' });
}

function ndjsonFor(day, part) {
  const lines = [];
  USERS.forEach((u, i) => {
    if ((i % 2) !== part) return;
    const c = creditsOf(i, day);
    if (c === null) return;
    lines.push(JSON.stringify({
      day, user_id: 1000 + i, user_login: u.login, enterprise_id: 7, ai_credits_used: c, user_initiated_interaction_count: 3 + i,
      used_chat: true,
      totals_by_model_feature: [
        { model: 'gpt-5', feature: 'chat_panel_ask_mode', user_initiated_interaction_count: 2 },
        { model: 'claude-sonnet-4.5', feature: 'chat_panel_agent_mode', user_initiated_interaction_count: 1 + i },
      ],
    }));
  });
  return lines.join('\n') + '\n';
}

function billingItems(day, org) {
  if (day === NO_BILLING) return [];
  const g = grossOf(day);
  const items = [
    { date: day, product: 'Copilot', sku: 'Copilot Premium Request', quantity: 100, unitType: 'requests', pricePerUnit: 0.04, grossAmount: g, discountAmount: 2, netAmount: g - 2, organizationName: 'org-one' },
    { date: day, product: 'Actions', sku: 'Compute', quantity: 10, unitType: 'minutes', pricePerUnit: 0.008, grossAmount: 5, discountAmount: 0, netAmount: 5, organizationName: 'org-one' },
  ];
  if (org) items.push({ date: day, product: 'Copilot', sku: 'Copilot Business', quantity: 3, unitType: 'seats', pricePerUnit: 1, grossAmount: EXTRA_GROSS, discountAmount: 0, netAmount: EXTRA_GROSS, organizationName: 'org-one', repositoryName: 'r' });
  return items;
}

function buildFake() {
  const app = express();
  app.use((req, res, next) => {
    const entry = { path: req.path, q: req.query, auth: req.headers.authorization, ver: req.headers['x-github-api-version'], accept: req.headers.accept, t: T.v };
    if (req.path.startsWith('/dl/')) { fake.dlAuth.push(req.headers.authorization || null); return next(); }
    fake.calls.push(entry);
    res.set('x-ratelimit-remaining', String(fake.remaining));
    res.set('x-ratelimit-reset', String(fake.reset || Math.floor(T.v / 1000) + 3600));
    res.set('x-ratelimit-limit', '5000');
    if (req.headers.authorization !== `Bearer ${GOOD}`) return ghErr(res, 401, 'Bad credentials');
    return next();
  });
  app.get('/user', (req, res) => res.json({ login: 'doug-bot' }));
  app.get('/rate_limit', (req, res) => res.json({ resources: {} }));
  app.get('/enterprises/ent1/copilot/metrics/reports/users-1-day', (req, res) => {
    const day = String(req.query.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ghErr(res, 400, 'day is required');
    if (day > fake.readyLast) return ghErr(res, 404, 'Not Found');
    return res.json({ report_day: day, download_links: [`${fake.base}/dl/${day}/0`, `${fake.base}/dl/${day}/1`] });
  });
  app.get('/dl/:day/:part', (req, res) => res.type('application/x-ndjson').send(ndjsonFor(req.params.day, Number(req.params.part))));
  const billing = (org) => (req, res) => {
    if (!org && fake.noBillingEnterprise404) return ghErr(res, 404, 'Not Found');
    const { year, month, day } = req.query;
    if (!year || !month) return ghErr(res, 400, 'year and month are required');
    const d = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!org && fake.throttled) { fake.throttled = false; return ghErr(res, 403, 'You have exceeded a secondary rate limit', { 'retry-after': '2' }); }
    return res.json({ timePeriod: { year: Number(year), month: Number(month), day: Number(day) }, usageItems: billingItems(d, org) });
  };
  app.get('/enterprises/ent1/settings/billing/usage', billing(false));
  app.get('/organizations/org-one/settings/billing/usage', billing(true));
  app.get('/enterprises/ent1/settings/billing/premium_request/usage', (req, res) => {
    const user = String(req.query.user || '');
    if (!user) return ghErr(res, 400, 'user is required');
    const p = premiumOf(user);
    return res.json({
      timePeriod: { year: Number(req.query.year), month: Number(req.query.month) }, user,
      usageItems: [
        { product: 'Copilot', sku: 'Copilot Premium Request', model: 'gpt-5', unitType: 'requests', pricePerUnit: 0.04, grossQuantity: p.a * 25, grossAmount: p.a, discountQuantity: 0, discountAmount: 0, netQuantity: p.a * 25, netAmount: p.a },
        { product: 'Copilot', sku: 'Copilot Premium Request', model: 'claude-sonnet-4.5', unitType: 'requests', pricePerUnit: 0.04, grossQuantity: p.b * 25, grossAmount: p.b, discountQuantity: 0, discountAmount: 0.5, netQuantity: p.b * 25, netAmount: p.b - 0.5 },
      ],
    });
  });
  app.get('/orgs/org-one', (req, res) => res.json({ login: 'org-one' }));
  app.get('/orgs/missing-org', (req, res) => ghErr(res, 404, 'Not Found'));
  app.get('/orgs/org-one/teams', (req, res) => {
    if (fake.teamsForbidden) return ghErr(res, 403, 'Resource not accessible by personal access token');
    const page = Number(req.query.page || 1);
    const all = [{ slug: 'platform', name: 'Platform Eng' }, { slug: 'data', name: 'Data' }, { slug: 'qa', name: 'QA' }];
    const per = 2;
    const slice = all.slice((page - 1) * per, page * per);
    if (page * per < all.length) res.set('link', `<${fake.base}/orgs/org-one/teams?per_page=${req.query.per_page}&page=${page + 1}>; rel="next", <${fake.base}/orgs/org-one/teams?page=2>; rel="last"`);
    return res.json(slice);
  });
  app.get('/orgs/org-one/teams/:slug/members', (req, res) => {
    const members = {
      platform: ['U2000000_capgroup', 'sam.young'], data: ['Stranger-Dev_capgroup'], qa: [],
    }[req.params.slug];
    return res.json(members.map((l) => ({ login: l })));
  });
  app.get('/orgs/org-one/copilot/billing/seats', (req, res) => {
    const page = Number(req.query.page || 1);
    const all = USERS.map((u) => ({ assignee: { login: u.login } }));
    const per = Number(req.query.per_page) || 50;
    const slice = all.slice((page - 1) * per, page * per);
    if (page * per < all.length) res.set('link', `<${fake.base}/orgs/org-one/copilot/billing/seats?per_page=${per}&page=${page + 1}>; rel="next"`);
    return res.json({ total_seats: all.length, seats: slice });
  });
  return app;
}

// ---- helpers -----------------------------------------------------------------------------

let app;
let admin;
let fakeServer;
let baseId;
let baseCounts;
const put = (patch) => admin.call('PUT', '/api/settings', { patch });
const platformCounts = (id) => Object.fromEntries(db.prepare('SELECT platform, count(*) n FROM usage WHERE dataset_id = ? GROUP BY platform').all(id).map((r) => [r.platform, r.n]));
const apiCalls = () => fake.calls.filter((c) => c.path !== '/user' && c.path !== '/rate_limit');

async function configure(extra) {
  const r = await put(Object.assign({
    'github.enabled': true, 'github.token': GOOD, 'github.enterprise': 'ent1', 'github.orgs': 'org-one',
    'github.base_url': fake.base + '/', 'github.dollars_mode': 'allocate', 'github.map_teams': true, 'vendors.months_back': 2,
  }, extra || {}));
  assert.equal(r.status, 200, r.text);
}

function resetFake() {
  fake.calls.length = 0; fake.dlAuth.length = 0; fake.readyLast = READY_LAST; fake.throttled = false; fake.remaining = 4999; fake.reset = 0;
  fake.noBillingEnterprise404 = false; fake.teamsForbidden = false;
  sleeps.length = 0;
  client.resetStats();
}

test.before(async () => {
  seedFixture({ months: 3, people: 120, profile: 'clean', endDate: '2026-10-30', label: 'baseline fixture' });
  baseId = datasets.active().id;
  baseCounts = platformCounts(baseId);
  const find = (uid) => db.prepare('SELECT person_key FROM people WHERE dataset_id = ? AND user_id = ?').get(baseId, uid);
  USERS[0].person = find('U2000000').person_key;
  USERS[1].person = find('U2000001').person_key;
  USERS[2].person = db.prepare("SELECT person_key FROM people WHERE dataset_id = ? AND email = 'wren.fischer@corp.example'").get(baseId).person_key;
  USERS[3].person = db.prepare("SELECT person_key FROM people WHERE dataset_id = ? AND email = 'sam.young@corp.example'").get(baseId).person_key;
  fakeServer = buildFake().listen(0);
  await new Promise((r) => fakeServer.once('listening', r));
  fake.base = `http://127.0.0.1:${fakeServer.address().port}`;
  client.setClock(() => T.v);
  client.setSleep(async (ms) => { sleeps.push(ms); T.v += ms; });
  client.setBackoff(5);
  time.setNow(NOW);
  app = await startApp();
  admin = await app.admin();
});
test.after(async () => {
  time.setNow(null);
  client.setClock(null);
  client.setSleep(null);
  client.setBackoff(null);
  if (app) await app.close();
  await new Promise((r) => fakeServer.close(r));
  teardown(ctx);
});
test.beforeEach(() => resetFake());

// ---- settings and registry -------------------------------------------------------------------

test('settings: validators, masked and encrypted token, defaults', async () => {
  assert.equal((await put({ 'github.base_url': 'ftp://nope' })).status, 400);
  assert.equal((await put({ 'github.base_url': 'https://ghe.example.com/api/v3/' })).status, 200);
  assert.equal(settings.get('github.base_url'), 'https://ghe.example.com/api/v3');
  assert.equal((await put({ 'github.rebuild_days': 0 })).status, 400);
  assert.equal((await put({ 'github.rebuild_days': 32 })).status, 400);
  assert.equal((await put({ 'github.rebuild_days': 3 })).status, 200);
  assert.equal((await put({ 'github.dollars_mode': 'nope' })).status, 400);
  assert.equal((await put({ 'github.calls_per_hour': 499 })).status, 400);
  assert.equal((await put({ 'github.calls_per_hour': 14001 })).status, 400);
  assert.equal((await put({ 'github.calls_per_hour': 4000 })).status, 200);
  assert.equal((await put({ 'github.map_teams': 'yes' })).status, 400);
  assert.equal((await put({ 'github.enterprise': 'bad slug' })).status, 400);
  assert.equal((await put({ 'github.orgs': 'org-one, org two!' })).status, 400);
  assert.equal((await put({ 'github.orgs': 'org-one  org-two,org-three' })).status, 200);
  assert.equal(settings.get('github.orgs'), 'org-one, org-two, org-three');
  const r = await put({ 'github.token': GOOD });
  assert.deepEqual(r.json['github.token'], { set: true });
  assert.ok(!r.text.includes(GOOD));
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'github.token'").get().value;
  assert.ok(stored.startsWith('"enc:v1:'), 'stored encrypted');
  assert.equal(settings.getSecret('github.token'), GOOD);
  assert.equal((await put({ 'github.token': { set: true } })).status, 200);
  assert.equal(settings.getSecret('github.token'), GOOD, 'the masked object keeps the token');
  await put({ 'github.token': null });
  assert.equal(settings.getSecret('github.token'), '');
  const d = (await admin.call('GET', '/api/settings')).json;
  assert.equal(d['github.dollars_mode'], 'allocate');
  assert.equal(d['github.rebuild_days'], 3);
  assert.equal(d['github.base_url'], 'https://ghe.example.com/api/v3');
  assert.equal(d['github.map_teams'], true);
});

test('registry lists github with problems and a describe() the generic card can render', () => {
  const c = connectors.list().find((x) => x.id === 'github');
  assert.ok(c);
  assert.equal(c.platform, 'github');
  assert.equal(c.enabled, false);
  assert.equal(c.configured, false);
  assert.deepEqual(c.problems, ['token', 'enterprise']);
  const keys = c.describe.fields.map((f) => f.key);
  for (const k of ['github.token', 'github.enterprise', 'github.orgs', 'github.dollars_mode', 'github.map_teams', 'github.rebuild_days', 'github.calls_per_hour', 'github.base_url']) assert.ok(keys.includes(k), k);
  assert.equal(c.describe.fields.find((f) => f.key === 'github.token').type, 'secret');
  assert.equal(c.describe.fields.find((f) => f.key === 'github.dollars_mode').type, 'select');
  assert.ok(c.describe.fields.find((f) => f.key === 'github.dollars_mode').options.length === 2);
  assert.equal(c.describe.history_floor, '2025-10-10');
  assert.ok(Array.isArray(c.describe.help) && c.describe.help.length > 0);
  assert.ok(github.rebuildDays() === 3 && github.maxDaysBack === 365);
});

// ---- test() ---------------------------------------------------------------------------------

test('test(): no token fails the first step with the reason, never throws, and makes no request', async () => {
  const t = await github.test();
  assert.equal(t.ok, false);
  assert.equal(t.steps[0].key, 'auth');
  assert.match(t.steps[0].detail, /Not configured: token, enterprise/);
  assert.deepEqual(t.steps.map((s) => s.key), ['auth', 'enterprise', 'metrics', 'orgs', 'seats', 'rate']);
  assert.ok(t.steps.slice(1).every((s) => s.ok === false && /Not checked/.test(s.detail)));
  assert.equal(fake.calls.length, 0);
});

test('test(): a refused token quotes GitHub and hides the token', async () => {
  await configure({ 'github.token': BAD });
  const r = await admin.call('POST', '/api/vendors/github/test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.steps[0].key, 'auth');
  assert.match(r.json.steps[0].detail, /HTTP 401/);
  assert.match(r.json.steps[0].detail, /Bad credentials/);
  assert.ok(!r.text.includes(BAD));
  assert.ok(r.json.steps.slice(1).every((s) => /Not checked/.test(s.detail)));
});

test('test(): a good token passes every step and reports login, link counts, seats and the rate budget', async () => {
  await configure();
  fake.readyLast = '2026-11-01'; // today minus 3
  const r = await admin.call('POST', '/api/vendors/github/test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, r.text);
  assert.deepEqual(r.json.steps.map((s) => s.key), ['auth', 'enterprise', 'metrics', 'orgs', 'seats', 'rate']);
  assert.match(r.json.steps[0].detail, /doug-bot/);
  assert.match(r.json.steps[1].detail, /billing usage items for 2026-11/);
  assert.match(r.json.steps[2].detail, /2 report download links for 2026-11-01/);
  assert.match(r.json.steps[3].detail, /1 organization readable/);
  assert.match(r.json.steps[4].detail, /org-one: 5/);
  assert.match(r.json.steps[5].detail, /4999 requests remaining/);
  for (const c of fake.calls) { assert.equal(c.auth, `Bearer ${GOOD}`); assert.equal(c.ver, '2022-11-28'); assert.equal(c.accept, 'application/vnd.github+json'); }
});

test('test(): a not-ready metrics day, a bad org and a refused enterprise are reported per step', async () => {
  await configure({ 'github.orgs': 'org-one missing-org' });
  const r = await admin.call('POST', '/api/vendors/github/test');
  assert.equal(r.json.ok, false);
  const by = Object.fromEntries(r.json.steps.map((s) => [s.key, s]));
  // today minus 3 is 2026-11-01, past the fake's ready day, so the metrics step fails with the 404 text
  assert.equal(by.metrics.ok, false);
  assert.match(by.metrics.detail, /404/);
  assert.equal(by.orgs.ok, false);
  assert.match(by.orgs.detail, /missing-org/);
  assert.equal(by.enterprise.ok, true);
});

// ---- pull() on its own -----------------------------------------------------------------------

const FROM = '2026-10-27';
const TO = '2026-11-04T08:00:00.000Z';
const READY_DAYS = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];

test('pull(): allocate mode normalises logins, allocates billing to the cent, stops at the not-ready day and reads orgs', async () => {
  await configure();
  fake.throttled = true;
  const logs = [];
  const progress = [];
  const r = await github.pull({ from: FROM, to: TO, log: (m) => logs.push(m), progress: (s, e) => progress.push([s, e]) });

  // window: 11-01 answers 404, so the five ready days are read and the window stops there
  const metricDays = apiCalls().filter((c) => c.path.endsWith('/users-1-day')).map((c) => c.q.day);
  assert.deepEqual(metricDays, READY_DAYS.concat(['2026-11-01']));
  assert.ok(logs.some((m) => /2026-11-01 is not ready yet/.test(m)));
  assert.equal(r.coverage.stopped_before, '2026-11-01');
  assert.equal(r.coverage.data_refreshed_at, '2026-10-31T00:00:00Z');

  // report downloads carry NO Authorization header; API calls do
  assert.equal(fake.dlAuth.length, READY_DAYS.length * 2);
  assert.ok(fake.dlAuth.every((a) => a === null));
  assert.ok(apiCalls().every((c) => c.auth === `Bearer ${GOOD}`));

  // login normalisation: lowercase, _capgroup stripped
  const logins = [...new Set(r.usage.map((u) => u.PersonKey))].sort();
  assert.deepEqual(logins, ['github:unattributed', 'sam.young', 'stranger-dev', 'u2000000', 'u2000001', 'wren.fischer']);
  assert.ok(r.usage.every((u) => u.Platform === 'github' && u.Model === '' && u.ConsumptionUnit === 'credits'));
  // credits per user per day, requests from user_initiated_interaction_count
  const u0 = r.usage.find((u) => u.Date === '2026-10-27' && u.PersonKey === 'u2000000');
  assert.equal(u0.Credits, creditsOf(0, '2026-10-27'));
  assert.equal(u0.Requests, 3);
  // grain: one row per (Date, PersonKey)
  assert.equal(new Set(r.usage.map((u) => `${u.Date}|${u.PersonKey}`)).size, r.usage.length);

  // dollars: the enterprise item is the same one the organization call returns (counted once) plus the
  // cost-center item only the organization call has; Actions is not Copilot and is dropped
  for (const d of READY_DAYS) {
    const rows = r.usage.filter((u) => u.Date === d);
    if (d === NO_BILLING) {
      assert.ok(rows.every((u) => u.CostUSD === '' && u.net_amount === ''), 'no billing yet leaves cost blank');
      continue;
    }
    const gross = grossOf(d) + EXTRA_GROSS;
    close(sum(rows, (u) => Number(u.CostUSD) || 0), gross, `${d} gross`);
    close(sum(rows, (u) => Number(u.discount_amount) || 0), 2, `${d} discount`);
    close(sum(rows, (u) => Number(u.net_amount) || 0), gross - 2, `${d} net`);
  }
  // shares follow credits
  const d1 = r.usage.filter((u) => u.Date === '2026-10-29');
  const tot = sum(d1, (u) => u.Credits || 0);
  for (const u of d1) close(u.CostUSD, (grossOf('2026-10-29') + EXTRA_GROSS) * (u.Credits / tot), 'share');
  assert.ok(d1.every((u) => u.CostSource === 'allocated'));
  // a day with dollars and no credits books one unattributed row
  const zero = r.usage.filter((u) => u.Date === ZERO_CREDITS && u.CostUSD !== '');
  assert.equal(zero.length, 1 + 0 * 1);
  assert.equal(zero.filter((u) => u.PersonKey === 'github:unattributed').length, 1);
  close(zero.find((u) => u.PersonKey === 'github:unattributed').CostUSD, grossOf(ZERO_CREDITS) + EXTRA_GROSS);

  // coverage
  const billed = READY_DAYS.filter((d) => d !== NO_BILLING);
  close(r.coverage.org_total_usd, sum(billed, (d) => grossOf(d) + EXTRA_GROSS), 'org total');
  close(r.coverage.user_rows_usd, r.coverage.org_total_usd - (grossOf(ZERO_CREDITS) + EXTRA_GROSS), 'user rows');
  assert.equal(r.coverage.licensed_seats, 5);
  assert.deepEqual(r.coverage.licensed_seats_by_org, { 'org-one': 5 });

  // detail: model x feature rows plus an 'all' row carrying the credits
  const dd = r.detail.filter((d) => d.date === '2026-10-27' && d.person_key === 'u2000000');
  assert.deepEqual(dd.map((d) => `${d.model}|${d.product}`).sort(), ['claude-sonnet-4.5|chat_panel_agent_mode', 'gpt-5|chat_panel_ask_mode', '|all']);
  assert.equal(dd.find((d) => d.product === 'all').tokens, creditsOf(0, '2026-10-27'));
  assert.equal(new Set(r.detail.map((d) => `${d.date}|${d.person_key}|${d.model}|${d.product}`)).size, r.detail.length);

  // the 403 with Retry-After was retried after waiting 2 s
  assert.ok(sleeps.includes(2000), `sleeps ${sleeps}`);
  assert.equal(client.stats.retries, 1);

  // orgs: teams across two Link pages, members as logins, all three teams listed
  assert.deepEqual(r.orgs.values.map((v) => v.value), ['org-one/Platform Eng', 'org-one/Data', 'org-one/QA']);
  assert.deepEqual(r.orgs.values[0].people.map((p) => p.person_key), ['u2000000', 'sam.young']);
  assert.equal(r.orgs.values[0].people[0].display_name, 'u2000000');
  assert.deepEqual(r.orgs.values[2].people, []);
  assert.ok(apiCalls().some((c) => c.path === '/orgs/org-one/teams' && c.q.page === '2'), 'followed the Link header');
  assert.ok(progress.some(([s]) => s === 'usage') && progress.some(([s]) => s === 'people'));
});

test('pull(): a 404 on the billing endpoint leaves cost blank; teams refused is logged and skipped', async () => {
  await configure({ 'github.orgs': 'org-one' });
  fake.noBillingEnterprise404 = true;
  fake.teamsForbidden = true;
  const logs = [];
  const r = await github.pull({ from: '2026-10-29', to: TO, log: (m) => logs.push(m) });
  assert.ok(r.usage.length > 0);
  assert.ok(logs.some((m) => /billing usage not available/.test(m)));
  assert.ok(logs.some((m) => /teams skipped for org-one/.test(m)));
  assert.deepEqual(r.orgs.values, []);
  assert.equal(r.coverage.licensed_seats, 5, 'seats still read');
});

test('pull(): blank github.orgs skips teams and seats; map_teams off skips teams only', async () => {
  await configure({ 'github.orgs': '' });
  const logs = [];
  let r = await github.pull({ from: '2026-10-30', to: TO, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /github\.orgs is blank/.test(m)));
  assert.deepEqual(r.orgs.values, []);
  assert.equal(r.coverage.licensed_seats, null);
  assert.equal(apiCalls().filter((c) => c.path.startsWith('/orgs/') || c.path.startsWith('/organizations/')).length, 0);
  resetFake();
  await configure({ 'github.orgs': 'org-one', 'github.map_teams': false });
  r = await github.pull({ from: '2026-10-30', to: TO });
  assert.deepEqual(r.orgs.values, []);
  assert.equal(r.coverage.licensed_seats, 5);
  assert.equal(apiCalls().filter((c) => c.path.endsWith('/teams')).length, 0);
});

test('pull(): per_user mode replaces allocated dollars with the vendor figures, one row per login and month', async () => {
  await configure({ 'github.dollars_mode': 'per_user' });
  const r = await github.pull({ from: FROM, to: TO });
  const premium = apiCalls().filter((c) => c.path.endsWith('/premium_request/usage'));
  assert.equal(premium.length, 5, 'one call per login for the single month in the window');
  assert.ok(premium.every((c) => c.q.year === '2026' && c.q.month === '10' && c.q.user));
  assert.deepEqual([...new Set(premium.map((c) => c.q.user))].sort(), ['sam.young', 'stranger-dev', 'u2000000', 'u2000001', 'wren.fischer']);
  // allocated cost is gone from the daily rows; the vendor figure sits on the first window day
  assert.ok(r.usage.filter((u) => u.CostSource === 'allocated').every((u) => u.PersonKey === 'github:unattributed'));
  const vendor = r.usage.filter((u) => u.CostSource === 'vendor');
  assert.equal(vendor.length, 5);
  assert.ok(vendor.every((u) => u.Date === FROM));
  for (const u of vendor) {
    const p = premiumOf(u.PersonKey);
    close(u.CostUSD, p.a + p.b, `${u.PersonKey} gross`);
    close(u.discount_amount, 0.5, 'discount');
    close(u.net_amount, p.a + p.b - 0.5, 'net');
  }
  // credits stay on the daily rows; the grain is still unique
  assert.ok(r.usage.some((u) => u.Date === '2026-10-29' && u.Credits !== '' && u.CostUSD === ''));
  assert.equal(new Set(r.usage.map((u) => `${u.Date}|${u.PersonKey}`)).size, r.usage.length);
  // per-model premium rows land in detail
  const pr = r.detail.filter((d) => d.product === 'premium_request' && d.person_key === 'u2000000');
  assert.deepEqual(pr.map((d) => d.model).sort(), ['claude-sonnet-4.5', 'gpt-5']);
  // the 'all' detail rows lost their allocated cost
  assert.ok(r.detail.filter((d) => d.product === 'all' && d.person_key !== 'github:unattributed').every((d) => d.cost_usd === null));
});

test('pull(): per_user mode stops when the hourly call budget is used up and the rest stays allocated', async () => {
  await configure({ 'github.dollars_mode': 'per_user' });
  settings.set('github.calls_per_hour', 1); // below the validator floor on purpose: this forces the stop
  const logs = [];
  const r = await github.pull({ from: FROM, to: TO, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /per-user dollars stopped after 0 calls: the budget of 1 calls an hour is used up/.test(m)));
  assert.equal(apiCalls().filter((c) => c.path.endsWith('/premium_request/usage')).length, 0);
  assert.ok(r.usage.some((u) => u.CostSource === 'allocated' && u.PersonKey !== 'github:unattributed'));
  settings.set('github.calls_per_hour', 4000);
});

test('client: remaining below 50 sleeps to the reset time; a 5xx retries; the token never appears in errors', async () => {
  await configure();
  fake.remaining = 10;
  fake.reset = Math.floor(T.v / 1000) + 600;
  await client.get('/user');
  await client.get('/user');
  assert.ok(sleeps.some((ms) => ms >= 600000 && ms <= 602000), `sleeps ${sleeps}`);
  assert.equal(client.stats.rateSleeps, 1);
  resetFake();
  await put({ 'github.token': BAD });
  await assert.rejects(() => client.get('/user'), (e) => {
    assert.equal(e.upstreamStatus, 401);
    assert.ok(!e.message.includes(BAD));
    return true;
  });
  await put({ 'github.token': GOOD });
  assert.equal(client.nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"'), 'https://x/a?page=2');
  assert.equal(client.nextLink('<https://x/a?page=1>; rel="prev"'), null);
  // a Link to another host is never followed (the token would leak)
  await assert.rejects(() => client.request('https://evil.example.com/steal'), /different host/);
});

test('pull(): a refused token throws with the GitHub message and no token text', async () => {
  await configure({ 'github.token': BAD });
  await assert.rejects(() => github.pull({ from: FROM, to: TO }), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /Bad credentials/);
    assert.ok(!e.message.includes(BAD));
    return true;
  });
  await put({ 'github.token': GOOD });
});

test('pull(): nothing to read when the window starts after the lag cut-off', async () => {
  await configure();
  const r = await github.pull({ from: '2026-11-03', to: TO });
  assert.equal(r.usage.length, 0);
  assert.equal(r.coverage.data_refreshed_at, null);
  assert.equal(apiCalls().filter((c) => c.path.endsWith('/users-1-day')).length, 0);
});

// ---- person resolution --------------------------------------------------------------------------

test('emailToPersonKey().byLogin: user_id first, then a unique e-mail local part, never an ambiguous one', () => {
  const map = activeCopy.emailToPersonKey(baseId);
  assert.ok(map instanceof Map);
  assert.equal(map.get('blake.yates@corp.example'), 'byates41');
  assert.equal(map.byLogin.get('u2000000'), USERS[0].person);
  assert.equal(map.byLogin.get('u2000001'), USERS[1].person);
  assert.equal(map.byLogin.get('wren.fischer'), USERS[2].person);
  assert.equal(map.byLogin.get('sam.young'), USERS[3].person);
  assert.equal(map.byLogin.get('stranger-dev'), undefined);
  // two people sharing a local part: nothing is guessed
  const ds = db.prepare("INSERT INTO datasets (label, source, status) VALUES ('amb', 'import', 'staged')").run().lastInsertRowid;
  const ins = db.prepare('INSERT INTO people (dataset_id, person_key, email, user_id, display_name) VALUES (?, ?, ?, ?, ?)');
  ins.run(ds, 'p1', 'dana@a.example', 'X1', 'Dana A');
  ins.run(ds, 'p2', 'dana@b.example', 'X2', 'Dana B');
  const m2 = activeCopy.emailToPersonKey(ds);
  assert.equal(m2.byLogin.get('dana'), undefined);
  assert.equal(m2.byLogin.get('x1'), 'p1');
  assert.equal(activeCopy.emailToPersonKey(null).byLogin.size, 0);
  db.prepare('DELETE FROM people WHERE dataset_id = ?').run(ds);
  db.prepare('DELETE FROM datasets WHERE id = ?').run(ds);
});

// ---- end to end ---------------------------------------------------------------------------------

test('vendor pull: GitHub rows replace the platform, resolve logins to People, carry the others over and map teams', async () => {
  await configure();
  const r = await admin.call('POST', '/api/vendors/pull', { ids: ['github'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.promoted, true);
  const ds = datasets.active();
  assert.equal(ds.id, r.json.dataset_id);
  const counts = platformCounts(ds.id);
  for (const p of ['anthropic', 'openai', 'cowork']) assert.equal(counts[p], baseCounts[p], `${p} carried over`);
  assert.ok(counts.github > 0);
  assert.notEqual(counts.github, baseCounts.github, 'the old GitHub rows were replaced, not appended');

  const keys = db.prepare("SELECT DISTINCT person_key FROM usage WHERE dataset_id = ? AND platform = 'github'").all(ds.id).map((x) => x.person_key).sort();
  assert.deepEqual(keys, ['github:unattributed', 'stranger-dev', USERS[0].person, USERS[1].person, USERS[2].person, USERS[3].person].sort());
  const matched = db.prepare("SELECT person_key, matched FROM usage WHERE dataset_id = ? AND platform = 'github' GROUP BY person_key").all(ds.id);
  assert.ok(matched.filter((m) => m.person_key !== 'stranger-dev' && m.person_key !== 'github:unattributed').every((m) => m.matched === 1));
  assert.equal(matched.find((m) => m.person_key === 'stranger-dev').matched, 0);

  // dollars: the usage table carries the allocated gross and the totals tie to the billing the fake served
  const cost = db.prepare("SELECT sum(cost_usd) c, sum(discount_amount) d, sum(net_amount) n FROM usage WHERE dataset_id = ? AND platform = 'github'").get(ds.id);
  const billed = READY_DAYS.filter((d) => d !== NO_BILLING).concat([]);
  // the window starts at the start of the month two months back, so earlier ready days add to the total
  assert.ok(cost.c > 0 && cost.n < cost.c);
  assert.ok(Math.abs(cost.c - r.json.by_vendor.github.coverage.org_total_usd) < 1e-4, `usage ${cost.c} vs billing ${r.json.by_vendor.github.coverage.org_total_usd}`);
  assert.ok(billed.length > 0);
  assert.equal(r.json.by_vendor.github.to, '2026-11-04');
  assert.equal(r.json.by_vendor.github.data_refreshed_at, '2026-10-31T00:00:00Z');
  assert.equal(r.json.by_vendor.github.coverage.licensed_seats, 5);

  // detail rows are keyed by the resolved person
  const det = db.prepare("SELECT count(*) n, count(DISTINCT person_key) p FROM vendor_usage_detail WHERE vendor = 'github'").get();
  assert.ok(det.n > counts.github);
  const d0 = db.prepare("SELECT count(*) n FROM vendor_usage_detail WHERE vendor = 'github' AND person_key = ?").get(USERS[0].person).n;
  assert.ok(d0 > 0);

  // the team mapping reached the org layer under the GitHub vendor id
  const orgs = (await admin.call('GET', '/api/vendor-orgs')).json;
  const list = Array.isArray(orgs) ? orgs : (orgs && (orgs.values || orgs.rows || orgs.orgs)) || [];
  assert.ok(JSON.stringify(list).includes('org-one/Platform Eng'));

  // verification ran the coverage check for this vendor
  const cov = db.prepare(
    "SELECT r.* FROM verification_results r JOIN verification_runs v ON v.id = r.run_id WHERE v.dataset_id = ? AND r.check_id = 'vendor_coverage' AND r.platform = 'github'"
  ).all(ds.id);
  assert.equal(cov.length, 1);

  // a second pull reads only the trailing window and keeps the totals
  const prevSum = cost.c;
  resetFake();
  const r2 = await admin.call('POST', '/api/vendors/pull', { ids: ['github'] });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.by_vendor.github.from, '2026-10-28', 'last pulled day 2026-10-31 minus 3 rebuild days');
  const ds2 = datasets.active();
  const c2 = db.prepare("SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND platform = 'github'").get(ds2.id).c;
  assert.ok(Math.abs(c2 - prevSum) < 1e-4, `second pull ${c2} vs ${prevSum}`);
  const days = new Set(apiCalls().filter((c) => c.path.endsWith('/users-1-day')).map((c) => c.q.day));
  assert.ok(!days.has('2026-10-27'), 'days before the trailing window were not read again');
});

test('per_user mode: a trailing pull starts at the month boundary and month dollars are not duplicated', async () => {
  assert.equal(github.describe().window_align, null, 'allocate mode does not align');
  await configure({ 'github.dollars_mode': 'per_user' });
  assert.equal(github.describe().window_align, 'month');
  const r1 = await admin.call('POST', '/api/vendors/pull', { ids: ['github'] });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.by_vendor.github.from, '2026-10-01', 'last day 10-31 minus 3 is 10-28, floored to the month start');
  const ds1 = datasets.active().id;
  resetFake();
  const r2 = await admin.call('POST', '/api/vendors/pull', { ids: ['github'] });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.by_vendor.github.from, '2026-10-01');
  const ds2 = datasets.active().id;
  assert.notEqual(ds1, ds2);
  const octCost = (id) => db.prepare("SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND platform = 'github' AND date >= '2026-10-01'").get(id).c;
  const expected = sum(['u2000000', 'u2000001', 'wren.fischer', 'sam.young', 'stranger-dev'], (l) => premiumOf(l).a + premiumOf(l).b) + grossOf(ZERO_CREDITS) + EXTRA_GROSS;
  close(octCost(ds1), expected, 'first pull October dollars');
  close(octCost(ds2), expected, 'second pull October dollars');
  const dup = db.prepare("SELECT count(*) n FROM (SELECT date, person_key FROM usage WHERE dataset_id = ? AND platform = 'github' GROUP BY date, person_key HAVING count(*) > 1)").get(ds2).n;
  assert.equal(dup, 0);
  const days = new Set(apiCalls().filter((c) => c.path.endsWith('/users-1-day')).map((c) => c.q.day));
  assert.ok(days.has('2026-10-01') && !days.has('2026-09-30'));
});
