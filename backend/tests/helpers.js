'use strict';
// Shared test setup. Every test file gets its own temp database through DB_PATH,
// so tests never touch backend/data/tracker.db.
const fs = require('fs');
const os = require('os');
const path = require('path');


function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aixp-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete process.env.APP_PASSWORD;
  const db = require('../src/db');
  db.open();
  // Same first-boot step as server.js: system roles plus admin / M0nkside.
  require('../src/services/authService').seedAdmin();
  return { dir, db };
}

function teardown(ctx) {
  try { ctx.db.close(); } catch (e) { /* already closed */ }
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

// Start the express app on an ephemeral port and return a tiny JSON client.
// app.call is anonymous (it still sends the csrf header unless opts.noCsrf).
// app.login(username, password) returns a client whose call() also sends the session cookie.
// app.admin() logs in as the seeded admin / M0nkside; app.as(user, password) is the same as login.
async function startApp() {
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function makeClient(cookie) {
    function headers(extra) {
      const h = { 'x-aixp-csrf': '1' };
      if (cookie) h.cookie = cookie;
      return Object.assign(h, extra || {});
    }
    async function call(method, url, body, opts) {
      const o = opts || {};
      const h = headers(o.headers);
      if (o.noCsrf) delete h['x-aixp-csrf'];
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      return { status: res.status, json, text, headers: res.headers };
    }
    return { call, headers, base, get cookie() { return cookie; } };
  }

  const anon = makeClient(null);
  async function login(username, password) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aixp-csrf': '1' },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${text}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return makeClient(cookie);
  }
  let adminP = null;
  const admin = () => { if (!adminP) adminP = login('admin', 'M0nkside'); return adminP; };
  return {
    server, base, call: anon.call, headers: anon.headers, login, admin, as: login,
    close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
  };
}

module.exports = { setup, teardown, startApp };
