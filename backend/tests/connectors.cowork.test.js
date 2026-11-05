'use strict';
// Microsoft Copilot Cowork connector (CONTRACT section 18.5) against a fake Entra login server and a fake
// Graph: client credentials, device code (pending then success), refresh with rotation, the Copilot usage
// report CSV (two paths), users and balances through $batch (20 per request), getTenantCreditBalance, a 429
// with Retry-After, concealed names, and the delegated-only rule on userBalances.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setup, teardown, startApp } = require('./helpers');

process.env.AIXP_SECRET_KEY = 'c3'.repeat(32);

const ctx = setup();
const db = ctx.db.getDb();
const gc = require('../src/services/connectors/graphClient');
const cowork = require('../src/services/connectors/cowork');
const connectors = require('../src/services/connectors');
const settings = require('../src/services/settings');
const staging = require('../src/services/staging');
const { normalize } = require('../src/services/normalize');
const time = require('../src/services/time');
const auth = require('../src/auth');

const NOW = '2026-11-04T08:30:00Z';
const SECRET = 'cowork-client-SECRET-0123456789';
const T = { v: Date.parse(NOW) };
const sleeps = [];

// ---- fake Microsoft ---------------------------------------------------------------------------

const fake = {
  base: '', server: null, calls: [], batches: [], tokenCalls: [], pendingPolls: 2, devicePolls: 0, rt: 'RT-1', rtN: 1, delN: 0,
  throttle: 0, reportAt: 'copilot', concealed: false, rotate: true, batchBroken: false, noTenantBalance: false,
  denyBalances: false, users: [], balances: new Map(), reportUpns: [], appRefused: false,
};

function buildUsers() {
  const users = [];
  for (let i = 1; i <= 47; i++) {
    const n = String(i).padStart(3, '0');
    users.push({
      id: `00000000-0000-0000-0000-000000000${n}`, userPrincipalName: `User${n}@Corp.Example`, mail: i % 5 === 0 ? `u${n}.mail@corp.example` : null,
      displayName: `User ${n}`, department: i % 3 === 0 ? 'Finance' : 'Technology', companyName: i % 4 === 0 ? 'Corp Holdings' : null, officeLocation: 'HQ',
    });
  }
  return users;
}
const byUpn = (u) => fake.users.find((x) => x.userPrincipalName.toLowerCase() === u.toLowerCase());
const byId = (id) => fake.users.find((x) => x.id === id);

function setBalances(map) {
  fake.balances = new Map();
  for (const [i, services] of Object.entries(map)) {
    const u = fake.users[Number(i)];
    fake.balances.set(u.id, {
      id: u.id,
      serviceBalances: services.map(([serviceId, q]) => ({
        serviceId, spendingPolicyId: 'pol-1', consumedQuantity: q, remainingQuantity: 1000 - q, unit: 'credits',
        dataStatus: { lastModifiedDateTime: '2026-11-04T06:00:00Z' },
      })),
    });
  }
}

const csv = (rows) => '\uFEFFReport Refresh Date,User Principal Name,Display Name,Last Activity Date\r\n'
  + rows.map((r) => `2026-11-02,${r.upn},"${r.name}",${r.last}`).join('\r\n') + '\r\n';

function graphErr(res, status, code, message) { return res.status(status).json({ error: { code, message } }); }

function subRequest(req, sub, delegated) {
  const url = new URL('http://x' + sub.url);
  const p = url.pathname;
  if (p === '/users') {
    const f = url.searchParams.get('$filter') || '';
    const m = f.match(/^userPrincipalName eq '(.*)'$/);
    if (!m) return { status: 400, body: { error: { code: 'BadRequest', message: 'unsupported filter' } } };
    const u = byUpn(m[1].replace(/''/g, "'"));
    return { status: 200, body: { value: u ? [u] : [] } };
  }
  const bm = p.match(/^\/copilot\/costManagement\/userBalances\/([^/]+)$/);
  if (bm) {
    if (!delegated) return { status: 403, body: { error: { code: 'Forbidden', message: 'delegated permission required' } } };
    if (fake.denyBalances) return { status: 403, body: { error: { code: 'Forbidden', message: 'role missing' } } };
    if (url.searchParams.get('$expand') !== 'serviceBalances') return { status: 400, body: { error: { code: 'BadRequest', message: '$expand=serviceBalances is required' } } };
    const b = fake.balances.get(decodeURIComponent(bm[1]));
    return b ? { status: 200, body: b } : { status: 404, body: { error: { code: 'NotFound', message: 'no balance' } } };
  }
  return { status: 404, body: { error: { code: 'NotFound', message: p } } };
}

function buildFake() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  // ---- Entra
  app.post('/login/:tenant/oauth2/v2.0/devicecode', (req, res) => {
    fake.tokenCalls.push({ path: 'devicecode', body: { ...req.body } });
    if (req.body.client_id !== 'client-guid') return res.status(400).json({ error: 'invalid_client', error_description: 'AADSTS700016: application not found' });
    if (!String(req.body.scope).includes('CopilotCostManagement-UserData.Read.All') || !String(req.body.scope).includes('offline_access')) {
      return res.status(400).json({ error: 'invalid_scope' });
    }
    fake.devicePolls = 0;
    return res.json({ user_code: 'ABCD-EFGH', device_code: 'DEV-CODE-1', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5, message: 'Go to the link and enter ABCD-EFGH.' });
  });
  app.post('/login/:tenant/oauth2/v2.0/token', (req, res) => {
    const b = req.body;
    fake.tokenCalls.push({ path: 'token', body: { ...b } });
    if (b.grant_type === 'client_credentials') {
      if (fake.appRefused || b.client_id !== 'client-guid' || b.client_secret !== SECRET) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' });
      }
      if (b.scope !== 'https://graph.microsoft.com/.default') return res.status(400).json({ error: 'invalid_scope' });
      return res.json({ access_token: 'APP-TOKEN', expires_in: 3600, token_type: 'Bearer' });
    }
    if (b.client_secret) return res.status(400).json({ error: 'invalid_request', error_description: 'public client flows send no secret' });
    if (b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (b.device_code === 'DEV-DENIED') return res.status(400).json({ error: 'access_denied', error_description: 'declined' });
      if (b.device_code === 'DEV-EXPIRED') return res.status(400).json({ error: 'expired_token' });
      if (b.device_code !== 'DEV-CODE-1') return res.status(400).json({ error: 'invalid_grant' });
      fake.devicePolls += 1;
      if (fake.devicePolls <= fake.pendingPolls) return res.status(400).json({ error: 'authorization_pending', error_description: 'pending' });
      fake.delN += 1;
      return res.json({ access_token: `DEL-${fake.delN}`, refresh_token: fake.rt, expires_in: 3600 });
    }
    if (b.grant_type === 'refresh_token') {
      if (b.refresh_token !== fake.rt) return res.status(400).json({ error: 'invalid_grant', error_description: 'AADSTS70008: refresh token expired' });
      fake.delN += 1;
      const out = { access_token: `DEL-${fake.delN}`, expires_in: 3600 };
      if (fake.rotate) { fake.rtN += 1; fake.rt = `RT-${fake.rtN}`; out.refresh_token = fake.rt; }
      return res.json(out);
    }
    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // ---- Graph
  app.use((req, res, next) => {
    if (!req.path.startsWith('/v1.0') && !req.path.startsWith('/beta')) return next();
    fake.calls.push({ path: req.path, t: T.v, method: req.method });
    const a = String(req.headers.authorization || '');
    if (!/^Bearer (APP-TOKEN|DEL-\d+)$/.test(a)) return graphErr(res, 401, 'InvalidAuthenticationToken', 'bad token');
    req.delegated = a.startsWith('Bearer DEL-');
    if (fake.throttle > 0) { fake.throttle -= 1; res.set('Retry-After', '2'); return graphErr(res, 429, 'TooManyRequests', 'slow down'); }
    return next();
  });
  const reportHandler = (kind) => (req, res) => {
    if (fake.reportAt !== kind) return graphErr(res, 404, 'NotFound', 'no such report path');
    if (req.delegated) return graphErr(res, 403, 'Forbidden', 'app-only expected');
    const rows = fake.reportUpns.map((u) => ({ upn: fake.concealed ? 'a1b2c3d4e5f60718293a4b5c6d7e8f90' + u.length : u, name: fake.concealed ? 'deadbeefdeadbeefdead' : u, last: '2026-11-01' }));
    res.set('content-type', 'text/csv');
    return res.send(csv(rows));
  };
  app.get('/v1.0/copilot/reports/:fn', reportHandler('copilot'));
  app.get('/v1.0/reports/:fn', reportHandler('reports'));
  app.get('/v1.0/me', (req, res) => (req.delegated ? res.json({ userPrincipalName: 'admin@corp.example', displayName: 'Admin' }) : graphErr(res, 403, 'Forbidden', 'delegated only')));
  app.get('/v1.0/users', (req, res) => {
    const f = req.query.$filter;
    if (f !== 'assignedLicenses/$count ne 0' || req.headers.consistencylevel !== 'eventual') return graphErr(res, 400, 'BadRequest', 'licensed filter needs ConsistencyLevel eventual');
    const skip = Number(req.query.$skiptoken || 0);
    const page = fake.users.slice(skip, skip + 30);
    const body = { value: page };
    if (skip + 30 < fake.users.length) body['@odata.nextLink'] = `${fake.base}/v1.0/users?$filter=${encodeURIComponent(f)}&$skiptoken=${skip + 30}`;
    return res.json(body);
  });
  const batch = (root) => (req, res) => {
    if (root === 'beta' && fake.batchBroken) return graphErr(res, 400, 'BadRequest', 'beta $batch is not supported');
    const reqs = (req.body && req.body.requests) || [];
    fake.batches.push({ root, n: reqs.length, delegated: req.delegated });
    if (reqs.length > 20) return graphErr(res, 400, 'BadRequest', 'a batch holds at most 20 requests');
    return res.json({ responses: reqs.map((q) => ({ id: q.id, ...subRequest(req, q, req.delegated) })) });
  };
  app.post(/^\/v1\.0\/\$batch$/, batch('v1.0'));
  app.post(/^\/beta\/\$batch$/, batch('beta'));
  app.get('/beta/copilot/costManagement/userBalances/:id', (req, res) => {
    const r = subRequest(req, { url: req.originalUrl.replace('/beta', '') }, req.delegated);
    return res.status(r.status).json(r.body);
  });
  app.get('/beta/copilot/costManagement/getTenantCreditBalance', (req, res) => {
    if (!req.delegated) return graphErr(res, 403, 'Forbidden', 'delegated only');
    if (fake.noTenantBalance) return graphErr(res, 403, 'Forbidden', 'CopilotCostManagement.Read.All not granted');
    return res.json({ billingMethodBalances: [{ billingMethod: 'prepaidCredits', purchasedQuantity: 25000, consumedQuantity: 4100, remainingQuantity: 20900 }] });
  });
  return app;
}

// ---- helpers -----------------------------------------------------------------------------------

let app;
let admin;
let fakeServer;
const put = (patch) => admin.call('PUT', '/api/settings', { patch });
const registered = () => !!connectors.get('cowork');

async function configure(extra) {
  const r = await put(Object.assign({
    'cowork.enabled': true, 'cowork.tenant_id': 'tenant-guid', 'cowork.client_id': 'client-guid', 'cowork.client_secret': SECRET,
    'cowork.graph_base': fake.base + '/', 'cowork.login_base': fake.base + '/login/', 'cowork.service_ids': '', 'cowork.users_source': 'copilot_report',
  }, extra || {}));
  assert.equal(r.status, 200, r.text);
}

function resetFake() {
  fake.calls.length = 0; fake.batches.length = 0; fake.tokenCalls.length = 0; sleeps.length = 0;
  fake.pendingPolls = 2; fake.devicePolls = 0; fake.throttle = 0; fake.reportAt = 'copilot'; fake.concealed = false; fake.rotate = false;
  fake.batchBroken = false; fake.noTenantBalance = false; fake.denyBalances = false; fake.appRefused = false;
  fake.rt = 'RT-1'; fake.rtN = 1;
  fake.reportUpns = fake.users.slice(0, 45).map((u) => u.userPrincipalName).concat(['ghost.user@corp.example', 'o\'brien@corp.example']);
  gc.resetStats(); gc.resetPacer(); gc.resetTokens();
}

const storedRefresh = () => db.prepare("SELECT value FROM settings WHERE key = 'cowork.refresh_token'").get().value;

async function signIn() {
  await cowork.actions.devicecode.start();
  T.v += 6000;
  await cowork.actions.devicecode.status();
  T.v += 6000;
  await cowork.actions.devicecode.status();
  T.v += 6000;
  const r = await cowork.actions.devicecode.status();
  assert.equal(r.state, 'done');
}

test.before(async () => {
  fake.users = buildUsers();
  setBalances({ 0: [['workIQ', 120], ['cowork', 30]], 1: [['workIQ', 15.5]], 2: [['cowork', 40]], 3: [['workIQ', 0]], 4: [['workIQ', 77]], 5: [] });
  fakeServer = buildFake().listen(0);
  await new Promise((r) => fakeServer.once('listening', r));
  fake.base = `http://127.0.0.1:${fakeServer.address().port}`;
  gc.setClock(() => T.v);
  gc.setSleep(async (ms) => { sleeps.push(ms); T.v += ms; });
  gc.setBackoff(5);
  time.setNow(NOW);
  app = await startApp();
  admin = await app.admin();
  resetFake();
});
test.after(async () => {
  time.setNow(null);
  gc.setClock(null); gc.setSleep(null); gc.setBackoff(null);
  if (app) await app.close();
  await new Promise((r) => fakeServer.close(r));
  teardown(ctx);
});
test.beforeEach(() => resetFake());

// ---- settings and registry --------------------------------------------------------------------

test('settings: validators, trailing slash, encrypted secrets that are never returned', async () => {
  assert.equal((await put({ 'cowork.graph_base': 'https://graph.example.com/' })).status, 200);
  assert.equal(settings.get('cowork.graph_base'), 'https://graph.example.com');
  assert.equal((await put({ 'cowork.graph_base': 'ftp://nope' })).status, 400);
  assert.equal((await put({ 'cowork.login_base': 'not a url' })).status, 400);
  assert.equal((await put({ 'cowork.users_source': 'everyone' })).status, 400);
  assert.equal((await put({ 'cowork.users_source': 'all_licensed' })).status, 200);
  assert.equal((await put({ 'cowork.service_ids': 'workIQ; DROP' })).status, 400);
  assert.equal((await put({ 'cowork.service_ids': 'workIQ , cowork' })).status, 200);
  assert.equal(settings.get('cowork.service_ids'), 'workIQ,cowork');
  assert.equal((await put({ 'cowork.tenant_id': 'bad tenant' })).status, 400);
  const r = await put({ 'cowork.client_secret': SECRET, 'cowork.refresh_token': 'RT-typed' });
  assert.deepEqual(r.json['cowork.client_secret'], { set: true });
  assert.deepEqual(r.json['cowork.refresh_token'], { set: true });
  assert.ok(!r.text.includes(SECRET) && !r.text.includes('RT-typed'));
  assert.ok(storedRefresh().startsWith('"enc:v1:'));
  assert.equal(settings.getSecret('cowork.refresh_token'), 'RT-typed');
  await put({ 'cowork.refresh_token': null });
  assert.equal(settings.getSecret('cowork.refresh_token'), '');
  const d = (await admin.call('GET', '/api/settings')).json;
  assert.equal(d['cowork.users_source'], 'all_licensed');
  assert.equal(d['cowork.rate'], 0.008);
  await put({ 'cowork.users_source': 'copilot_report', 'cowork.service_ids': '', 'cowork.graph_base': 'https://graph.microsoft.com' });
});

test('describe(): fields, help, devicecode action; problems() names what is missing', async () => {
  await put({ 'cowork.client_secret': null, 'cowork.tenant_id': '', 'cowork.client_id': '' });
  assert.deepEqual(cowork.problems(), ['tenant id', 'client id', 'client secret']);
  const d = cowork.describe();
  assert.deepEqual(d.actions, [{ key: 'devicecode', label: 'Sign in as administrator', kind: 'devicecode' }]);
  assert.ok(d.fields.every((f) => f.key.startsWith('cowork.')));
  assert.equal(d.fields.find((f) => f.key === 'cowork.client_secret').type, 'secret');
  assert.equal(d.fields.find((f) => f.key === 'cowork.users_source').type, 'select');
  assert.ok(d.fields.filter((f) => f.advanced).map((f) => f.key).includes('cowork.graph_base'));
  assert.ok(d.help.some((h) => /public client flows/.test(h)));
  assert.match(d.limits.history, /none/);
  if (registered()) {
    const row = connectors.list().find((c) => c.id === 'cowork');
    assert.equal(row.platform, 'cowork');
    assert.equal(row.configured, false);
    assert.deepEqual(row.problems, ['tenant id', 'client id', 'client secret']);
  }
});

// ---- test() -----------------------------------------------------------------------------------

test('test(): not configured fails the first step and checks nothing else', async () => {
  const t = await cowork.test();
  assert.equal(t.ok, false);
  assert.deepEqual(t.steps.map((s) => s.key), ['app_auth', 'report', 'users', 'admin_signin', 'balances', 'tenant_balance']);
  assert.match(t.steps[0].detail, /Not configured: tenant id, client id, client secret/);
  assert.ok(t.steps.slice(1).every((s) => !s.ok && /Not checked/.test(s.detail)));
  assert.equal(fake.calls.length + fake.tokenCalls.length, 0);
});

test('test(): a refused client secret quotes the error and hides the secret', async () => {
  await configure({ 'cowork.client_secret': 'wrong-secret-value' });
  const t = await cowork.test();
  assert.equal(t.ok, false);
  assert.equal(t.steps[0].key, 'app_auth');
  assert.match(t.steps[0].detail, /HTTP 401/);
  assert.match(t.steps[0].detail, /invalid_client/);
  assert.ok(!JSON.stringify(t).includes('wrong-secret-value'));
  assert.ok(t.steps.slice(1).every((s) => /Not checked/.test(s.detail)));
});

test('test(): without the delegated token the first four steps pass and the sign-in step says so', async () => {
  await configure();
  const t = await cowork.test();
  assert.equal(t.ok, false);
  const by = Object.fromEntries(t.steps.map((s) => [s.key, s]));
  assert.equal(by.app_auth.ok, true);
  assert.equal(by.report.ok, true);
  assert.match(by.report.detail, /47 users in the D30 report/);
  assert.equal(by.users.ok, true);
  assert.match(by.users.detail, /5 of 5 sampled users resolved/);
  assert.equal(by.admin_signin.ok, false);
  assert.equal(by.admin_signin.detail, 'Sign in as administrator first');
  assert.equal(by.balances.ok, false);
  assert.match(by.balances.detail, /no administrator sign-in/);
  assert.equal(by.tenant_balance.ok, false);
});

test('test(): with the delegated token every step passes and the balances are summarised', async () => {
  await configure();
  await signIn();
  resetFake(); // keeps the stored refresh token (settings), resets the fake counters
  fake.rt = 'RT-1';
  const t = await cowork.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  const by = Object.fromEntries(t.steps.map((s) => [s.key, s]));
  assert.match(by.balances.detail, /2 service balances: workIQ=120 credits, cowork=30 credits/);
  assert.match(by.tenant_balance.detail, /prepaidCredits: consumed 4100, remaining 20900/);
  // the report fell back to the second path when the first answered 404
  resetFake();
  fake.reportAt = 'reports';
  const t2 = await cowork.test();
  assert.match(t2.steps.find((s) => s.key === 'report').detail, /\/v1\.0\/reports\//);
  assert.ok(fake.calls.some((c) => c.path.startsWith('/v1.0/copilot/reports')) && fake.calls.some((c) => c.path.startsWith('/v1.0/reports')));
  // a tenant balance refused for scope is a failed step, not a thrown error
  resetFake();
  fake.noTenantBalance = true;
  const t3 = await cowork.test();
  assert.equal(t3.ok, false);
  const tb = t3.steps.find((s) => s.key === 'tenant_balance');
  assert.equal(tb.ok, false);
  assert.match(tb.detail, /CopilotCostManagement\.Read\.All/);
});

test('test(): concealed names are reported and fail the report step', async () => {
  await configure();
  fake.concealed = true;
  const t = await cowork.test();
  const rep = t.steps.find((s) => s.key === 'report');
  assert.equal(rep.ok, false);
  assert.match(rep.detail, /names are concealed in the admin center reports setting/);
  assert.equal(t.steps.find((s) => s.key === 'users').ok, false);
  assert.equal(cowork.isConcealed(['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'DEADBEEFDEADBEEFDEAD@x.example']), true);
  assert.equal(cowork.isConcealed(['ann.lee@corp.example', 'a1b2c3d4e5f60718293a4b5c6d7e8f90']), false);
  assert.equal(cowork.isConcealed([]), false);
});

// ---- device code flow -----------------------------------------------------------------------------

test('device code: start, pending twice, then done stores the refresh token encrypted', async () => {
  await configure();
  await put({ 'cowork.refresh_token': null });
  const s = await cowork.actions.devicecode.start();
  assert.equal(s.user_code, 'ABCD-EFGH');
  assert.equal(s.verification_uri, 'https://microsoft.com/devicelogin');
  assert.equal(s.expires_in, 900);
  assert.match(s.message, /ABCD-EFGH/);
  assert.ok(!('device_code' in s), 'the device code stays server side');
  const d = fake.tokenCalls[0];
  assert.equal(d.path, 'devicecode');
  assert.equal(d.body.client_id, 'client-guid');
  assert.ok(!('client_secret' in d.body), 'public client flow sends no secret');
  // polling sooner than the interval does not call Microsoft
  assert.deepEqual(await cowork.actions.devicecode.status(), { state: 'pending', detail: '' });
  assert.equal(fake.tokenCalls.length, 1);
  T.v += 5100;
  assert.equal((await cowork.actions.devicecode.status()).state, 'pending');
  T.v += 5100;
  assert.equal((await cowork.actions.devicecode.status()).state, 'pending');
  T.v += 5100;
  const done = await cowork.actions.devicecode.status();
  assert.deepEqual(done, { state: 'done', detail: 'admin@corp.example' });
  const pollCalls = fake.tokenCalls.filter((c) => c.body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(pollCalls.length, 3);
  assert.equal(settings.getSecret('cowork.refresh_token'), 'RT-1');
  assert.ok(storedRefresh().startsWith('"enc:v1:') && !storedRefresh().includes('RT-1'));
  assert.ok(!(await admin.call('GET', '/api/settings')).text.includes('RT-1'));
  // the final state is sticky
  assert.deepEqual(await cowork.actions.devicecode.status(), { state: 'done', detail: 'admin@corp.example' });
});

test('device code: a refused app registration and an expired code end with a reason', async () => {
  await configure({ 'cowork.client_id': 'other-app' });
  await assert.rejects(() => cowork.actions.devicecode.start(), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /AADSTS700016/);
    assert.match(e.message, /public client flows/);
    return true;
  });
  await configure();
  await cowork.actions.devicecode.start();
  T.v += 901 * 1000;
  const expired = await cowork.actions.devicecode.status();
  assert.equal(expired.state, 'error');
  assert.match(expired.detail, /expired/);
  assert.equal((await cowork.actions.devicecode.status()).state, 'error', 'error is sticky');
  assert.equal((await cowork.actions.devicecode.start()).user_code, 'ABCD-EFGH', 'a new start resets');
});

test('device code: the action routes dispatch, 404 for unknown connectors and actions', async () => {
  const bad = await admin.call('POST', '/api/vendors/nope/actions/devicecode');
  assert.equal(bad.status, 404);
  assert.equal((await admin.call('GET', '/api/vendors/anthropic/actions/devicecode')).status, 404);
  assert.equal((await admin.call('POST', '/api/vendors/anthropic/actions/__proto__')).status, 404);
  assert.deepEqual(auth.requiredFor('POST', '/vendors/cowork/actions/devicecode'), ['data.manage']);
  assert.deepEqual(auth.requiredFor('GET', '/vendors/cowork/actions/devicecode'), ['data.manage']);
  if (!registered()) return;
  await configure();
  assert.equal((await admin.call('POST', '/api/vendors/cowork/actions/nothing')).status, 404);
  const s = await admin.call('POST', '/api/vendors/cowork/actions/devicecode');
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.user_code, 'ABCD-EFGH');
  const st = await admin.call('GET', '/api/vendors/cowork/actions/devicecode');
  assert.equal(st.status, 200);
  assert.equal(st.json.state, 'pending');
  const anon = await app.call('POST', '/api/vendors/cowork/actions/devicecode');
  assert.equal(anon.status, 401);
});

// ---- pull -----------------------------------------------------------------------------------------

test('pull(): needs the administrator sign-in', async () => {
  await configure();
  await put({ 'cowork.refresh_token': null });
  await assert.rejects(() => cowork.pull({ from: '2026-10-01', to: NOW }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /Sign in as administrator/);
    return true;
  });
});

test('pull(): one snapshot per user, service filter, orgs from departments, coverage, batching and pacing', async () => {
  await configure();
  await signIn();
  resetFake();
  fake.rt = 'RT-1';
  fake.throttle = 1;
  const logs = [];
  const progress = [];
  const r = await cowork.pull({ from: '2026-10-01', to: NOW, log: (m) => logs.push(m), progress: (s, e) => progress.push([s, e]) });

  // snapshot rows: users 0, 1, 2, 4 have credits; 3 has zero, 5 has no services, the rest no balance record
  assert.equal(r.usage.length, 4);
  assert.ok(r.usage.every((u) => u.Date === '2026-11-04' && u.Platform === 'cowork' && u.ConsumptionUnit === 'credits' && u.Model === ''));
  const row = (i) => r.usage.find((u) => u.PersonKey === (fake.users[i].mail || fake.users[i].userPrincipalName).toLowerCase());
  assert.equal(row(0).Credits, 150);
  assert.equal(row(1).Credits, 15.5);
  assert.equal(row(2).Credits, 40);
  assert.equal(row(4).Credits, 77);
  assert.equal(row(4).PersonKey, 'u005.mail@corp.example', 'mail wins over the UPN when present');
  assert.equal(row(0).PersonKey, 'user001@corp.example');
  assert.equal(row(0).Email, row(0).PersonKey);
  assert.equal(r.usage.some((u) => u.CostUSD !== ''), false, 'CostUSD is left to normalize (derived from cowork.rate)');
  // detail rows per service, product = serviceId, credits in tokens, cost = credits x rate
  const d0 = r.detail.filter((d) => d.person_key === 'user001@corp.example');
  assert.deepEqual(d0.map((d) => d.product).sort(), ['cowork', 'workIQ']);
  assert.equal(d0.find((d) => d.product === 'workIQ').tokens, 120);
  assert.ok(Math.abs(d0.find((d) => d.product === 'workIQ').cost_usd - 120 * 0.008) < 1e-9);
  assert.ok(r.detail.every((d) => d.vendor === 'cowork' && d.date === '2026-11-04'));
  // orgs: departments and company names with their members (47 users, 2 report names not in Entra)
  const orgs = Object.fromEntries(r.orgs.values.map((v) => [v.value, v.people]));
  assert.deepEqual(Object.keys(orgs).sort(), ['Corp Holdings', 'Finance', 'Technology']);
  assert.equal(orgs.Finance.length, 15 - 0, 'user 3,6,...,45 are in the report: 15 members');
  assert.ok(orgs.Technology.every((p) => p.person_key === p.email && p.display_name.startsWith('User ')));
  // coverage
  assert.equal(r.coverage.org_total_usd, null);
  assert.equal(r.coverage.user_rows_usd, null);
  assert.equal(r.coverage.data_refreshed_at, '2026-11-04T06:00:00Z');
  assert.equal(r.coverage.tenant_balance.billingMethodBalances[0].remainingQuantity, 20900);
  // the report path, the 429 and the batches
  assert.ok(logs.some((m) => /2 of 47 users in the Copilot report were not found in Entra|2 of 47/.test(m)));
  assert.equal(gc.stats.retries >= 1, true);
  assert.ok(sleeps.includes(2000), 'Retry-After honoured');
  const v1 = fake.batches.filter((b) => b.root === 'v1.0');
  const beta = fake.batches.filter((b) => b.root === 'beta');
  assert.equal(v1.reduce((a, b) => a + b.n, 0), 47, 'one user lookup per report name');
  assert.deepEqual(v1.map((b) => b.n), [20, 20, 7]);
  assert.equal(beta.reduce((a, b) => a + b.n, 0), 45);
  assert.ok(beta.every((b) => b.n <= 20 && b.delegated === true), 'balances use the delegated token, 20 at most');
  assert.ok(v1.every((b) => b.delegated === false), 'users use the app token');
  for (let i = 1; i < fake.calls.length; i++) assert.ok(fake.calls[i].t - fake.calls[i - 1].t >= 200, `gap ${i}`);
  assert.ok(progress.some(([s]) => s === 'auth') && progress.some(([s]) => s === 'people') && progress.some(([s]) => s === 'usage'));
});

test('pull(): the service filter counts only the named services', async () => {
  await configure({ 'cowork.service_ids': 'cowork' });
  await signIn();
  resetFake();
  const r = await cowork.pull({ from: '2026-10-01', to: NOW });
  assert.equal(r.usage.length, 2);
  assert.deepEqual(r.usage.map((u) => u.Credits).sort((a, b) => a - b), [30, 40]);
  assert.ok(r.detail.every((d) => d.product === 'cowork'));
  await put({ 'cowork.service_ids': '' });
});

test('pull(): concealed names stop the report mode; all_licensed works and pages the user list', async () => {
  await configure();
  await signIn();
  resetFake();
  fake.concealed = true;
  await assert.rejects(() => cowork.pull({ from: '2026-10-01', to: NOW }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /concealed in the admin center reports setting/);
    return true;
  });
  await put({ 'cowork.users_source': 'all_licensed' });
  resetFake();
  fake.concealed = true;
  const r = await cowork.pull({ from: '2026-10-01', to: NOW });
  assert.equal(r.usage.length, 4);
  assert.ok(fake.calls.filter((c) => c.path === '/v1.0/users').length >= 2, 'followed @odata.nextLink');
  assert.ok(!fake.calls.some((c) => c.path.includes('/reports/')), 'no report call in all_licensed mode');
  await put({ 'cowork.users_source': 'copilot_report' });
});

test('pull(): a rotated refresh token is stored and used next time; a dead one asks for a new sign-in', async () => {
  await configure();
  await signIn();
  resetFake();
  fake.rt = 'RT-1';
  fake.rotate = true;
  await cowork.pull({ from: '2026-10-01', to: NOW });
  assert.equal(settings.getSecret('cowork.refresh_token'), 'RT-2', 'the replacement token was stored');
  assert.ok(storedRefresh().startsWith('"enc:v1:'));
  gc.resetTokens();
  await cowork.pull({ from: '2026-10-01', to: NOW });
  assert.equal(settings.getSecret('cowork.refresh_token'), 'RT-3');
  gc.resetTokens();
  fake.rt = 'RT-other'; // Microsoft no longer accepts what is stored
  await assert.rejects(() => cowork.pull({ from: '2026-10-01', to: NOW }), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /stored administrator sign-in \(HTTP 400\)/);
    assert.match(e.message, /Sign in as administrator again/);
    assert.ok(!e.message.includes('RT-3'));
    return true;
  });
  assert.equal(settings.getSecret('cowork.refresh_token'), 'RT-3', 'a failed refresh keeps the stored token');
});

test('pull(): a refused balances read names the permission; a broken beta $batch falls back to single calls', async () => {
  await configure();
  await signIn();
  resetFake();
  fake.rt = 'RT-1';
  fake.denyBalances = true;
  await assert.rejects(() => cowork.pull({ from: '2026-10-01', to: NOW }), /CopilotCostManagement-UserData\.Read\.All/);
  resetFake();
  fake.rt = 'RT-1';
  fake.rotate = false;
  fake.batchBroken = true;
  const r = await cowork.pull({ from: '2026-10-01', to: NOW });
  assert.equal(r.usage.length, 4);
  assert.ok(fake.calls.filter((c) => c.path.startsWith('/beta/copilot/costManagement/userBalances/')).length >= 45);
});

test('pull(): a refused client secret throws with the Microsoft message and no secret', async () => {
  await configure();
  await signIn();
  resetFake();
  fake.appRefused = true;
  await assert.rejects(() => cowork.pull({ from: '2026-10-01', to: NOW }), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /AADSTS7000215/);
    assert.ok(!e.message.includes(SECRET));
    return true;
  });
});

// ---- normalize: latest snapshot per person and month across two pulls --------------------------------

test('normalize keeps the latest snapshot per person-month across two pulls and derives cost from the rate', async () => {
  await configure();
  await put({ 'cowork.rate': 0.01 });
  await signIn();
  resetFake();
  fake.rt = 'RT-1';
  fake.rotate = false;
  time.setNow('2026-11-02T10:00:00Z');
  const first = await cowork.pull({ from: '2026-10-01', to: '2026-11-02T10:00:00Z' });
  setBalances({ 0: [['workIQ', 180], ['cowork', 30]], 1: [['workIQ', 15.5]], 2: [['cowork', 40]], 3: [['workIQ', 5]], 4: [['workIQ', 77]], 5: [] });
  time.setNow(NOW);
  const second = await cowork.pull({ from: '2026-10-01', to: NOW });
  setBalances({ 0: [['workIQ', 120], ['cowork', 30]], 1: [['workIQ', 15.5]], 2: [['cowork', 40]], 3: [['workIQ', 0]], 4: [['workIQ', 77]], 5: [] });
  assert.equal(first.usage.length, 4);
  assert.equal(second.usage.length, 5, 'user 3 gained credits in the second snapshot');

  const id = staging.createDataset({ label: 'cowork snapshots', source: 'import', options: {} });
  const prior = [{ Date: '2026-10-15', PersonKey: 'user001@corp.example', Platform: 'cowork', Model: '', Tokens: '', Credits: 500, ConsumptionUnit: 'credits', CostUSD: '', Requests: '' }];
  staging.loadTables(id, { usage: [...prior, ...first.usage, ...second.usage] });
  normalize(id);
  const rows = db.prepare("SELECT person_key, date, credits, cost_usd, cost_source, consumption_unit FROM usage WHERE dataset_id = ? AND platform = 'cowork' ORDER BY person_key, date").all(id);
  const u1 = rows.filter((x) => x.person_key === 'user001@corp.example');
  assert.deepEqual(u1.map((x) => [x.date, x.credits]), [['2026-10-15', 500], ['2026-11-04', 210]], 'one row per month: the latest snapshot wins');
  assert.equal(rows.length, 6, 'five November persons plus the October row');
  assert.equal(u1[1].cost_source, 'derived');
  assert.ok(Math.abs(u1[1].cost_usd - 2.1) < 1e-9, 'credits x cowork.rate');
  assert.equal(u1[1].consumption_unit, 'credits');
  const u3 = rows.find((x) => x.person_key === 'user004@corp.example');
  assert.equal(u3.credits, 5);
  await put({ 'cowork.rate': 0.008 });
});
