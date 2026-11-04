'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const { seedFixture } = require('./seed');
const { CAVEAT } = require('../src/platforms');
const { toCsv, cell } = require('../src/services/csvExport');
let app;

test.before(async () => {
  seedFixture({ people: 80, months: 3, endDate: '2026-10-30', seed: 3, profile: 'clean' });
  app = await startApp();
  app.call = (await app.admin()).call; // signed in as admin / M0nkside
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

test('every export starts with the caveat line', async () => {
  for (const u of ['summary', 'trend?grain=week', 'platform?platform=anthropic', 'organization?dim=region', 'models', 'users']) {
    const [name, qs] = u.split('?');
    const r = await app.call('GET', `/api/export/${name}.csv${qs ? `?${qs}` : ''}`);
    assert.equal(r.status, 200, u);
    const lines = r.text.split('\r\n');
    assert.equal(lines[0], `# ${CAVEAT}`, u);
    assert.ok(lines.length > 3, u);
  }
});

test('export rows carry units and match the report', async () => {
  const r = await app.call('GET', '/api/export/summary.csv');
  const lines = r.text.trim().split('\r\n');
  assert.ok(lines[1].startsWith('platform,name'));
  assert.ok(lines.some((l) => l.startsWith('anthropic,') && l.includes(',tokens,')));
  assert.ok(lines.some((l) => l.startsWith('github,') && l.includes(',credits,')));
  const u = await app.call('GET', '/api/export/users.csv?platform=github');
  assert.ok(u.text.split('\r\n')[1].includes('usd_github'));
  assert.equal((await app.call('GET', '/api/export/bogus.csv')).status, 404);
  assert.equal((await app.call('GET', '/api/export/platform.csv')).status, 400);
  assert.equal((await app.call('GET', '/api/export/summary.csv?basis=zzz')).status, 400);
});

test('formula guard prefixes cells that start with = + - @', () => {
  assert.equal(cell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(cell('+1'), "'+1");
  assert.equal(cell('-cmd'), "'-cmd");
  assert.equal(cell('@x'), "'@x");
  assert.equal(cell(-5), '-5');
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell(null), '');
  const csv = toCsv(['name', 'v'], [{ name: '=HYPERLINK("x")', v: 1 }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], `# ${CAVEAT}`);
  assert.equal(lines[2], '"\'=HYPERLINK(""x"")",1');
});
