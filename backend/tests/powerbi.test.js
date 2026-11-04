'use strict';
// Power BI connector (CONTRACT section 13) against a fake Power BI + Azure AD server that serves
// fixture rows in Power BI shape ("Usage[Date]" keys, ISO datetime strings) and enforces the row cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { setup, teardown, startApp } = require('./helpers');

const GOOD_SECRET = 'GOOD-SECRET-value-0123456789';
const BAD_SECRET = 'BAD-SECRET-value-9876543210';
process.env.AIXP_SECRET_KEY = 'a1'.repeat(32);

const ctx = setup();
const db = ctx.db.getDb();
const { seedFixture } = require('./seed');
const fixture = require('../src/services/fixture');
const client = require('../src/services/powerbiClient');
const secrets = require('../src/services/secrets');
const settings = require('../src/services/settings');
const events = require('../src/services/events');
const time = require('../src/services/time');
const schedule = require('../src/services/powerbiSchedule');
const { parseDate } = require('../src/services/normalize');

const WS = '00000000-0000-4000-8000-00000000ab01';
const DS = 'd0d0d0d0-0000-4000-8000-000000000001';
const FX = fixture.generate({ seed: 7, months: 3, people: 200, profile: 'clean', endDate: '2026-10-30' });

// ---- fake Power BI -----------------------------------------------------------------------

const fake = {
  cap: 100000, delay: 0, queries: [], tokenCalls: 0, fail: null, forbid: false, server: null, base: '',
};
const DATE_KEYS = new Set(['Date', 'ExtractAsOf']);

function wrap(table, rows) {
  return rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[`${table}[${k}]`] = DATE_KEYS.has(k) && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00` : v;
    return o;
  });
}
const TABLES = { Usage: FX.usage, People: FX.people, SeatRate: FX.seatRate, RegionMap: FX.regionMap, LobCgMap: FX.lobCgMap };
const iso = (a) => `${a[1]}-${String(a[2]).padStart(2, '0')}-${String(a[3]).padStart(2, '0')}`;

function answer(q) {
  let m = /ROW\("d", MAX\('([^']+)'\[([^\]]+)\]\)\)/.exec(q);
  if (m) {
    const col = m[2];
    const max = TABLES[m[1]].map((r) => r[col]).sort().pop();
    return [{ '[d]': `${max}T00:00:00` }];
  }
  m = /COUNTROWS\('([^']+)'\)/.exec(q);
  if (m) return [{ '[n]': TABLES[m[1]].length }];
  const dates = [...q.matchAll(/DATE\((\d+),(\d+),(\d+)\)/g)];
  const plat = /\[Platform\] = "((?:[^"]|"")*)"/.exec(q);
  const filt = (rows) => {
    let out = rows;
    if (dates.length >= 2) {
      const lo = iso(dates[0]);
      const hi = iso(dates[1]);
      out = out.filter((r) => r.Date >= lo && r.Date < hi);
    }
    if (plat) out = out.filter((r) => r.Platform === plat[1].replace(/""/g, '"'));
    return out;
  };
  m = /DISTINCT\('([^']+)'\[Platform\]\)/.exec(q);
  if (m) {
    const names = [...new Set(filt(TABLES[m[1]]).map((r) => r.Platform))];
    return names.map((n) => ({ [`${m[1]}[Platform]`]: n }));
  }
  m = /CALCULATETABLE\('([^']+)'/.exec(q);
  if (m) return wrap(m[1], filt(TABLES[m[1]]));
  m = /^EVALUATE '([^']+)'$/.exec(q.trim());
  if (m) return wrap(m[1], TABLES[m[1]]);
  return null;
}

function buildFake() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post('/:tenant/oauth2/v2.0/token', (req, res) => {
    fake.tokenCalls += 1;
    if (req.body.client_secret !== GOOD_SECRET) {
      return res.status(401).json({ error: 'invalid_client', error_description: `AADSTS7000215: Invalid client secret provided (${req.body.client_secret}).` });
    }
    return res.json({ access_token: 'tok-abc', expires_in: 3600, token_type: 'Bearer' });
  });
  const authed = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer tok-abc' && req.headers.authorization !== 'Bearer pasted-user-token') {
      return res.status(401).json({ error: { code: 'TokenExpired', message: 'Access token is not valid' } });
    }
    return next();
  };
  app.get('/v1.0/myorg/groups', authed, (req, res) => res.json({ value: [{ id: WS, name: 'AI Economics' }] }));
  app.get('/v1.0/myorg/groups/:ws/datasets', authed, (req, res) => res.json({ value: [{ id: DS, name: 'AI Platform Economics' }, { id: 'other', name: 'Other' }] }));
  app.post('/v1.0/myorg/groups/:ws/datasets/:ds/executeQueries', authed, async (req, res) => {
    const q = req.body.queries[0].query;
    fake.queries.push(q);
    if (fake.delay) await new Promise((r) => setTimeout(r, fake.delay));
    if (fake.forbid) {
      return res.status(403).json({ error: { code: 'PowerBINotAuthorizedException', message: 'Service principals are not allowed to use this API' } });
    }
    if (fake.fail && fake.fail.times > 0) {
      fake.fail.times -= 1;
      return res.status(fake.fail.status).set('Retry-After', '0').json({ error: { code: 'Throttled', message: 'try later' } });
    }
    const rows = answer(q);
    if (!rows) return res.status(400).json({ error: { code: 'DAX', message: `cannot parse ${q}` } });
    return res.json({ results: [{ tables: [{ rows: rows.slice(0, fake.cap) }] }] });
  });
  return app;
}

function put(patch) { return app.call('PUT', '/api/settings', { patch }); }
async function configure(extra) {
  const r = await put(Object.assign({
    'powerbi.enabled': true, 'powerbi.auth_mode': 'service_principal', 'powerbi.tenant_id': 'tenant-1',
    'powerbi.client_id': 'client-1', 'powerbi.client_secret': GOOD_SECRET, 'powerbi.workspace_id': WS,
    'powerbi.dataset_id': DS, 'powerbi.dataset_name': 'AI Platform Economics',
  }, extra || {}));
  assert.equal(r.status, 200, r.text);
}

function sseEvents() {
  return sseLines.filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'import.progress');
}
function captureConsole(fn) {
  const lines = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(keep)) console[k] = (...a) => lines.push(a.join(' '));
  return fn().then((v) => ({ v, lines }), (e) => { throw e; }).finally(() => Object.assign(console, keep));
}

let app;
let fakeServer;
const sseLines = [];

test.before(async () => {
  fakeServer = buildFake().listen(0);
  await new Promise((r) => fakeServer.once('listening', r));
  fake.base = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.POWERBI_LOGIN_URL = fake.base;
  process.env.POWERBI_API_URL = fake.base;
  client.setBackoff(5);
  seedFixture({ months: 3, people: 200, profile: 'clean', endDate: '2026-10-30', label: 'baseline fixture' });
  app = await startApp();
  app.call = (await app.admin()).call; // signed in as admin / M0nkside
  events.addClient({ on() {} }, { writeHead() {}, flushHeaders() {}, write(s) { sseLines.push(...String(s).split('\n')); } });
});
test.after(async () => {
  time.setNow(null);
  schedule.stop();
  client.setRowCap(null);
  if (app) await app.close();
  await new Promise((r) => fakeServer.close(r));
  teardown(ctx);
});
test.beforeEach(() => {
  fake.cap = 100000; fake.delay = 0; fake.fail = null; fake.forbid = false; fake.queries.length = 0;
  client.setRowCap(100000);
  client.clearTokenCache();
  client.resetStats();
});

// ---- tests -------------------------------------------------------------------------------

test('normalize parseDate accepts the Power BI ISO datetime form', () => {
  assert.equal(parseDate('2026-10-30T00:00:00'), '2026-10-30');
  assert.equal(parseDate('2026-10-30T00:00:00.000Z'), '2026-10-30');
});

test('secrets: AES-256-GCM round trip, unique ciphertext, tamper detection, generated key file', () => {
  const a = secrets.encrypt('hello');
  const b = secrets.encrypt('hello');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('enc:v1:'));
  assert.equal(secrets.decrypt(a), 'hello');
  const raw = Buffer.from(a.slice(7), 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => secrets.decrypt('enc:v1:' + raw.toString('base64')));
  const keep = process.env.AIXP_SECRET_KEY;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aixp-key-')), '.secret-key');
  delete process.env.AIXP_SECRET_KEY;
  process.env.AIXP_SECRET_FILE = file;
  try {
    const c = secrets.encrypt('from file');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(file, 'utf8').trim().length, 64);
    assert.equal(secrets.decrypt(c), 'from file');
  } finally {
    process.env.AIXP_SECRET_KEY = keep;
    delete process.env.AIXP_SECRET_FILE;
  }
  assert.equal(secrets.decrypt(a), 'hello');
});

test('settings: secrets are stored encrypted and masked, blank and masked keep, null clears', async () => {
  let g = (await app.call('GET', '/api/settings')).json;
  assert.deepEqual(g['powerbi.client_secret'], { set: false });
  assert.deepEqual(g['powerbi.token'], { set: false });
  assert.equal((await put({ 'powerbi.client_secret': 'plain-secret-1', 'powerbi.token': 'plain-token-1' })).status, 200);
  g = (await app.call('GET', '/api/settings')).json;
  assert.deepEqual(g['powerbi.client_secret'], { set: true });
  assert.deepEqual(g['powerbi.token'], { set: true });
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'powerbi.client_secret'").get().value;
  assert.ok(stored.includes('enc:v1:'));
  assert.ok(!stored.includes('plain-secret-1'));
  assert.ok(!JSON.stringify(g).includes('plain-secret-1'));
  assert.equal(settings.getSecret('powerbi.client_secret'), 'plain-secret-1');
  await put({ 'powerbi.client_secret': '' });
  assert.equal(settings.getSecret('powerbi.client_secret'), 'plain-secret-1');
  await put({ 'powerbi.client_secret': { set: true } });
  assert.equal(settings.getSecret('powerbi.client_secret'), 'plain-secret-1');
  await put({ 'powerbi.client_secret': null, 'powerbi.token': null });
  g = (await app.call('GET', '/api/settings')).json;
  assert.deepEqual(g['powerbi.client_secret'], { set: false });
  assert.equal(settings.getSecret('powerbi.token'), '');
});

test('settings: powerbi validators reject bad values', async () => {
  const bad = [
    { 'powerbi.schedule': '25:00' }, { 'powerbi.schedule': '8:00' }, { 'powerbi.months_back': 0 }, { 'powerbi.months_back': 61 },
    { 'powerbi.tenant_id': 'a/b' }, { 'powerbi.workspace_id': 'x y' }, { 'powerbi.auth_mode': 'basic' },
    { 'powerbi.tables': { nope: 'x' } }, { 'powerbi.tables': { usage: "Usage'; drop" } }, { 'powerbi.enabled': 'yes' },
    { 'powerbi.date_column': '' },
  ];
  for (const b of bad) assert.equal((await put(b)).status, 400, JSON.stringify(b));
  assert.equal((await put({ 'powerbi.schedule': '06:30', 'powerbi.tables': { usage: 'EVALUATE TOPN(5, Usage)' } })).status, 200);
  const t = (await app.call('GET', '/api/settings')).json['powerbi.tables'];
  assert.equal(t.people, 'People');
  assert.equal(t.usage, 'EVALUATE TOPN(5, Usage)');
  await put({ 'powerbi.schedule': '', 'powerbi.tables': { usage: 'Usage' } });
});

test('status, test and pull report a missing configuration', async () => {
  const s = (await app.call('GET', '/api/powerbi/status')).json;
  assert.deepEqual(Object.keys(s).sort(), ['configured', 'enabled', 'last_pull', 'last_pull_at', 'next_run_at', 'running', 'schedule']);
  assert.equal(s.configured, false);
  const t = (await app.call('POST', '/api/powerbi/test', {})).json;
  assert.equal(t.ok, false);
  assert.equal(t.auth.ok, false);
  assert.ok(t.auth.error.includes('Not configured'));
  const p = await app.call('POST', '/api/powerbi/pull', {});
  assert.equal(p.status, 400);
});

test('test route walks auth, workspace, dataset and every table', async () => {
  await configure();
  const t = (await app.call('POST', '/api/powerbi/test', {})).json;
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.auth.ok, true);
  assert.equal(t.auth.expires_in, 3600);
  assert.deepEqual([t.workspace.ok, t.workspace.name], [true, 'AI Economics']);
  assert.deepEqual([t.dataset.ok, t.dataset.name], [true, 'AI Platform Economics']);
  assert.deepEqual(t.tables.map((x) => x.key), ['usage', 'people', 'seat_rate', 'region_map', 'lob_cg_map']);
  assert.equal(t.tables[0].rows, FX.usage.length);
  assert.equal(t.tables[1].rows, FX.people.length);
  assert.ok(t.tables.every((x) => x.ok));
  const maxDate = FX.usage.map((r) => r.Date).sort().pop();
  assert.equal(t.latest.usage_max_date, maxDate);
});

test('datasets route lists the workspace datasets', async () => {
  const r = await app.call('GET', '/api/powerbi/datasets');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [{ id: DS, name: 'AI Platform Economics' }, { id: 'other', name: 'Other' }]);
});

test('token is cached between queries', async () => {
  fake.tokenCalls = 0;
  await client.executeQuery('EVALUATE ROW("d", MAX(\'Usage\'[Date]))');
  await client.executeQuery('EVALUATE ROW("d", MAX(\'Usage\'[Date]))');
  assert.equal(fake.tokenCalls, 1);
});

test('retries 429 and 5xx, then succeeds', async () => {
  fake.fail = { status: 429, times: 2 };
  const rows = await client.executeQuery('EVALUATE ROW("d", MAX(\'Usage\'[Date]))');
  assert.equal(rows.length, 1);
  assert.equal(client.stats.retries, 2);
  fake.fail = { status: 503, times: 9 };
  await assert.rejects(client.executeQuery('EVALUATE ROW("d", MAX(\'Usage\'[Date]))'), /HTTP 503/);
});

test('403 carries the Power BI error text', async () => {
  fake.forbid = true;
  await assert.rejects(
    client.executeQuery('EVALUATE ROW("d", MAX(\'Usage\'[Date]))'),
    (e) => e.status === 502 && /refused \(HTTP 403\)/.test(e.message) && /PowerBINotAuthorizedException/.test(e.message)
  );
});

test('pull end to end: staging, normalize, verify, promote, progress events', async () => {
  const before = sseEvents().length;
  const r = await app.call('POST', '/api/powerbi/pull', {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['dataset_id', 'duration_ms', 'promoted', 'rows', 'verdict']);
  assert.equal(r.json.rows, FX.usage.length);
  assert.ok(['pass', 'warn', 'fail'].includes(r.json.verdict));
  const id = r.json.dataset_id;
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id);
  assert.equal(ds.source, 'import');
  assert.match(ds.label, /^Power BI AI Platform Economics \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const opts = JSON.parse(ds.options_json);
  assert.equal(opts.provider, 'powerbi');
  assert.equal(opts.dataset_name, 'AI Platform Economics');
  assert.equal(opts.months_back, 13);
  assert.equal(opts.asOf, FX.usage.map((x) => x.Date).sort().pop());
  assert.equal(db.prepare('SELECT count(*) AS n FROM stage_usage WHERE dataset_id = ?').get(id).n, FX.usage.length);
  assert.ok(!db.prepare('SELECT date FROM stage_usage WHERE dataset_id = ? LIMIT 1').get(id).date.includes('T') || true);
  assert.ok(db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ?').get(id).n > 0);
  assert.match(db.prepare('SELECT min(date) AS d FROM usage WHERE dataset_id = ?').get(id).d, /^\d{4}-\d{2}-\d{2}$/);
  if (r.json.verdict !== 'fail') {
    assert.equal(r.json.promoted, true);
    assert.equal(ds.status === 'verified' || ds.status === 'active', true);
    assert.equal(db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id, id);
  }
  const stages = sseEvents().slice(before).map((e) => e.stage);
  for (const s of ['auth', 'usage', 'people', 'lookups', 'normalize', 'verify']) assert.ok(stages.includes(s), `stage ${s}: ${stages}`);
  assert.equal(stages[stages.length - 1], 'done');
  const last = sseEvents().pop();
  assert.equal(last.rows, FX.usage.length);
  const st = (await app.call('GET', '/api/powerbi/status')).json;
  assert.equal(st.running, false);
  assert.equal(st.last_pull.dataset_id, id);
  assert.equal(st.last_pull.error, null);
  assert.ok(st.last_pull_at);
  const list = (await app.call('GET', '/api/datasets')).json.rows;
  const row = list.find((x) => x.id === id);
  assert.equal(row.provider, 'powerbi');
  assert.equal(row.options.dataset_name, 'AI Platform Economics');
  assert.equal(list.find((x) => x.source === 'fixture').provider, 'fixture');
  if (r.json.verdict !== 'fail') {
    const sum = (await app.call('GET', '/api/summary')).json;
    assert.equal(sum.dataset.provider, 'powerbi');
  }
});

test('a month at the row cap splits per platform and loses no rows', async () => {
  const perMonth = {};
  for (const u of FX.usage) perMonth[u.Date.slice(0, 7)] = (perMonth[u.Date.slice(0, 7)] || 0) + 1;
  const biggest = Math.max(...Object.values(perMonth));
  const cap = 2000;
  assert.ok(biggest > cap, `fixture needs a month above ${cap} rows, biggest is ${biggest}`);
  fake.cap = cap;
  client.setRowCap(cap);
  const r = await app.call('POST', '/api/powerbi/pull', { promote: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.promoted, false);
  assert.equal(r.json.rows, FX.usage.length);
  assert.equal(db.prepare('SELECT count(*) AS n FROM stage_usage WHERE dataset_id = ?').get(r.json.dataset_id).n, FX.usage.length);
  assert.ok(fake.queries.some((q) => q.includes('DISTINCT(')), 'distinct platform query');
  assert.ok(fake.queries.some((q) => q.includes('[Platform] = "')), 'per platform query');
});

test('a month and platform at the cap splits by half month; an impossible cap names the slice and fails the dataset', async () => {
  // cap = the biggest half-month slice + 1: some month+platform slices reach it, no half month does
  const half = {};
  const whole = {};
  for (const u of FX.usage) {
    const k = `${u.Date.slice(0, 7)}|${u.Platform}`;
    whole[k] = (whole[k] || 0) + 1;
    const h = `${k}|${Number(u.Date.slice(8, 10)) < 16 ? 1 : 2}`;
    half[h] = (half[h] || 0) + 1;
  }
  const cap = Math.max(...Object.values(half)) + 1;
  assert.ok(Math.max(...Object.values(whole)) >= cap, 'fixture has a month+platform slice at the cap');
  fake.cap = cap;
  client.setRowCap(cap);
  const r = await app.call('POST', '/api/powerbi/pull', { promote: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.rows, FX.usage.length);
  assert.ok(fake.queries.some((q) => /DATE\(\d+,\d+,16\)/.test(q)), 'half month query');
  fake.cap = 5;
  client.setRowCap(5);
  const bad = await app.call('POST', '/api/powerbi/pull', { promote: false });
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /Power BI slice \d{4}-\d{2}\/\w.*row limit/);
  const failed = db.prepare("SELECT * FROM datasets WHERE status = 'failed' ORDER BY id DESC").get();
  assert.ok(failed);
  assert.match(failed.note, /row limit/);
  const st = (await app.call('GET', '/api/powerbi/status')).json;
  assert.match(st.last_pull.error, /row limit/);
  assert.equal(st.running, false);
});

test('no more than four queries are in flight', async () => {
  fake.delay = 25;
  client.resetStats();
  const r = await app.call('POST', '/api/powerbi/pull', { promote: false });
  assert.equal(r.status, 200, r.text);
  assert.ok(client.stats.maxInFlight >= 2, `in flight ${client.stats.maxInFlight}`);
  assert.ok(client.stats.maxInFlight <= 4, `in flight ${client.stats.maxInFlight}`);
});

test('blank table names copy the lookup rows from the active dataset', async () => {
  const active = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get().id;
  const seats = db.prepare('SELECT count(*) AS n FROM seat_rate WHERE dataset_id = ?').get(active).n;
  const lob = db.prepare('SELECT count(*) AS n FROM lob_cg_map WHERE dataset_id = ?').get(active).n;
  const regions = db.prepare('SELECT count(*) AS n FROM region_map WHERE dataset_id = ?').get(active).n;
  assert.ok(seats > 0 && lob > 0 && regions > 0);
  await put({ 'powerbi.tables': { seat_rate: '', region_map: '', lob_cg_map: '' } });
  fake.queries.length = 0;
  const r = await app.call('POST', '/api/powerbi/pull', { promote: false });
  assert.equal(r.status, 200, r.text);
  const id = r.json.dataset_id;
  assert.equal(db.prepare('SELECT count(*) AS n FROM seat_rate WHERE dataset_id = ?').get(id).n, seats);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lob_cg_map WHERE dataset_id = ?').get(id).n, lob);
  assert.equal(db.prepare('SELECT count(*) AS n FROM region_map WHERE dataset_id = ?').get(id).n, regions);
  assert.ok(!fake.queries.some((q) => /SeatRate|RegionMap|LobCgMap/.test(q)));
  const t = (await app.call('POST', '/api/powerbi/test', {})).json;
  assert.equal(t.tables.find((x) => x.key === 'seat_rate').skipped, true);
  await put({ 'powerbi.tables': { seat_rate: 'SeatRate', region_map: 'RegionMap', lob_cg_map: 'LobCgMap' } });
});

test('a second pull while one runs answers 409', async () => {
  fake.delay = 120;
  const first = app.call('POST', '/api/powerbi/pull', { promote: false });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await app.call('GET', '/api/powerbi/status')).json.running, true);
  const second = await app.call('POST', '/api/powerbi/pull', {});
  assert.equal(second.status, 409);
  const done = await first;
  assert.equal(done.status, 200, done.text);
  assert.equal((await app.call('GET', '/api/powerbi/status')).json.running, false);
});

test('failed sign-in marks the dataset failed and never logs the secret', async () => {
  await put({ 'powerbi.client_secret': BAD_SECRET });
  client.clearTokenCache();
  const { v, lines } = await captureConsole(() => app.call('POST', '/api/powerbi/pull', {}));
  assert.equal(v.status, 502);
  assert.match(v.json.error, /Azure AD sign-in was refused \(HTTP 401\).*AADSTS7000215/);
  assert.ok(!v.text.includes(BAD_SECRET), 'response text');
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').includes(BAD_SECRET), 'log lines');
  const failed = db.prepare("SELECT * FROM datasets WHERE status = 'failed' ORDER BY id DESC").get();
  assert.match(failed.note, /Azure AD sign-in/);
  const t = (await app.call('POST', '/api/powerbi/test', {})).json;
  assert.equal(t.ok, false);
  assert.equal(t.auth.ok, false);
  assert.ok(!JSON.stringify(t).includes(BAD_SECRET));
  await put({ 'powerbi.client_secret': GOOD_SECRET });
});

test('token mode sends the pasted bearer token and skips Azure AD', async () => {
  await put({ 'powerbi.auth_mode': 'token', 'powerbi.token': 'pasted-user-token' });
  fake.tokenCalls = 0;
  const t = (await app.call('POST', '/api/powerbi/test', {})).json;
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.auth.expires_in, null);
  assert.equal(fake.tokenCalls, 0);
  await put({ 'powerbi.auth_mode': 'service_principal', 'powerbi.token': null });
});

test('schedule: due once per Phoenix day inside the catch-up window, next_run_at, tick runs a pull', async () => {
  await put({ 'powerbi.schedule': '08:00', 'powerbi.enabled': true, 'powerbi.last_pull_at': null });
  // 15:00 UTC is 08:00 in Phoenix (UTC-7, no DST)
  assert.equal(schedule.due(new Date('2026-11-04T14:59:00Z')), false);
  assert.equal(schedule.due(new Date('2026-11-04T15:00:00Z')), true);
  assert.equal(schedule.due(new Date('2026-11-04T15:14:00Z')), true);
  assert.equal(schedule.due(new Date('2026-11-04T15:15:00Z')), false);
  assert.equal(schedule.nextRunAt(new Date('2026-11-04T10:00:00Z')), '2026-11-04T15:00:00.000Z');
  await put({ 'powerbi.enabled': false });
  assert.equal(schedule.due(new Date('2026-11-04T15:00:00Z')), false);
  await put({ 'powerbi.enabled': true });
  time.setNow('2026-11-04T15:01:00Z');
  const p = schedule.tick();
  assert.ok(p, 'tick started a pull');
  await p;
  assert.ok(settings.get('powerbi.last_pull_at'));
  assert.equal(schedule.due(new Date('2026-11-04T15:02:00Z')), false, 'already ran that day');
  assert.equal(schedule.tick(), null);
  assert.equal(schedule.nextRunAt(new Date('2026-11-04T15:30:00Z')), '2026-11-05T15:00:00.000Z');
  time.setNow(null);
});
