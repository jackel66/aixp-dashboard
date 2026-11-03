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
  return { dir, db };
}

function teardown(ctx) {
  try { ctx.db.close(); } catch (e) { /* already closed */ }
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

// Start the express app on an ephemeral port and return a tiny JSON client.
async function startApp() {
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, json, text };
  }
  return { server, base, call, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { setup, teardown, startApp };
