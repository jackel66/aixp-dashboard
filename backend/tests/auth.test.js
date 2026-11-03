'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
let app;

test.before(async () => {
  seedFixture({ people: 40, months: 2, endDate: '2026-10-30', seed: 4, profile: 'clean' });
  app = await startApp();
});
test.after(async () => {
  delete process.env.APP_PASSWORD;
  if (app) await app.close();
  teardown(ctx);
});

test('gate off: routes are open and session says not required', async () => {
  delete process.env.APP_PASSWORD;
  assert.equal((await app.call('GET', '/api/summary')).status, 200);
  assert.deepEqual((await app.call('GET', '/api/auth/session')).json, { required: false, authenticated: true });
});

test('gate on: 401 without a session, health stays open, login sets a cookie that works', async () => {
  process.env.APP_PASSWORD = 'correct horse';
  for (const u of ['/api/summary', '/api/settings', '/api/users', '/api/datasets', '/api/export/summary.csv']) {
    const r = await app.call('GET', u);
    assert.equal(r.status, 401, u);
    assert.ok(r.json.error);
  }
  assert.equal((await app.call('PUT', '/api/settings', { patch: {} })).status, 401);
  assert.equal((await app.call('GET', '/api/health')).status, 200);
  assert.equal((await app.call('GET', '/api/auth/session')).json.authenticated, false);
  assert.equal((await app.call('POST', '/api/auth/login', { password: 'wrong' })).status, 401);
  assert.equal((await app.call('POST', '/api/auth/login', {})).status, 400);

  const res = await fetch(`${app.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const ok = await fetch(`${app.base}/api/summary`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  const sess = await (await fetch(`${app.base}/api/auth/session`, { headers: { cookie } })).json();
  assert.equal(sess.authenticated, true);
  await fetch(`${app.base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal((await fetch(`${app.base}/api/summary`, { headers: { cookie } })).status, 401);
  delete process.env.APP_PASSWORD;
});
