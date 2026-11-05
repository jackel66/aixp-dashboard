'use strict';
// Integration help routes (CONTRACT section 17).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const connectors = require('../src/services/connectors');
const auth = require('../src/auth');
let app;
let viewer;

test('setup: a Viewer with no data scope', async () => {
  app = await startApp();
  const admin = await app.admin();
  const roles = await admin.call('GET', '/api/access/roles');
  const role = (roles.json.rows || roles.json).find((r) => r.name === 'Viewer');
  const r = await admin.call('POST', '/api/access/users', { username: 'hank', display_name: 'Hank', password: 'Viewer-pass-123', role_ids: [role.id] });
  assert.equal(r.status < 300, true, r.text);
  viewer = await app.login('hank', 'Viewer-pass-123');
});

test('help: a Viewer reads the list and one entry', async () => {
  const r = await viewer.call('GET', '/api/help/integrations');
  assert.equal(r.status, 200);
  assert.equal(r.json.rows.length >= 6, true);
  const one = await viewer.call('GET', '/api/help/integrations/powerbi');
  assert.equal(one.status, 200);
  assert.equal(one.json.id, 'powerbi');
  assert.equal((await viewer.call('GET', '/api/help/integrations/nope')).status, 404);
});

test('help: signed out is 401', async () => {
  assert.equal((await app.call('GET', '/api/help/integrations')).status, 401);
  assert.equal((await app.call('GET', '/api/help/integrations/ad')).status, 401);
});

test('help: the gate treats an empty key list as signed in, no permission', () => {
  assert.deepEqual(auth.requiredFor('GET', '/help/integrations'), []);
  assert.deepEqual(auth.requiredFor('GET', '/help/integrations/ad'), []);
  assert.notDeepEqual(auth.requiredFor('POST', '/help/integrations'), []);
});

test('help: entries are ASCII, complete and unique, and cover the built connectors', async () => {
  const r = await viewer.call('GET', '/api/help/integrations');
  const keys = ['id', 'name', 'status', 'kind', 'summary', 'urls', 'ports', 'credentials', 'permissions', 'limits', 'where', 'notes'];
  const ids = r.json.rows.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of r.json.rows) {
    for (const k of keys) assert.ok(k in e, `${e.id} lacks ${k}`);
    assert.ok(['built', 'planned'].includes(e.status));
    assert.ok(['source', 'identity', 'vendor'].includes(e.kind));
    assert.ok(Array.isArray(e.urls) && Array.isArray(e.credentials) && Array.isArray(e.permissions) && Array.isArray(e.limits) && Array.isArray(e.notes));
    assert.equal(/[^\x20-\x7E\n]/.test(JSON.stringify(e)), false, `${e.id} has non-ASCII text`);
  }
  const built = r.json.rows.filter((e) => e.status === 'built').map((e) => e.id).sort();
  assert.deepEqual(built, [...connectors.list().map((c) => c.id), 'powerbi', 'ad'].sort());
});

test('teardown', async () => {
  await app.close();
  teardown(ctx);
});
