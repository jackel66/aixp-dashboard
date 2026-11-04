'use strict';
// Seam check: call every API route the pages use and diff the key structure of the
// answer against the mock file the page was built on (frontend/src/mock/*.json).
// Usage: node scripts/smoke-shapes.js [baseUrl]   (default http://localhost:3090)
// Exit code 1 when any route fails, answers slowly, or lacks a key the mock has.
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3090';
const MOCK = path.join(__dirname, '..', '..', 'frontend', 'src', 'mock');
const BUDGET_MS = 200;

// mock file -> route (query strings chosen to exercise the default page reads)
const ROUTES = [
  ['summary', '/api/summary'],
  ['trend-week', '/api/trend?grain=week'],
  ['trend-day', '/api/trend?grain=day'],
  ['trend-month', '/api/trend?grain=month'],
  ['platform-anthropic', '/api/platforms/anthropic'],
  ['platform-openai', '/api/platforms/openai'],
  ['platform-github', '/api/platforms/github'],
  ['platform-cowork', '/api/platforms/cowork'],
  ['organization', '/api/organization?dim=lob_cg'],
  ['organization-cell', '/api/organization/cell?dim=lob_cg&key=__unmatched__&platform=anthropic'],
  ['models', '/api/models'],
  ['model-detail', null], // resolved from /api/models first row
  ['users', '/api/users?pageSize=10&sort=usd'],
  ['user-detail', null], // resolved from /api/users first row
  ['verification', '/api/verification'],
  ['verification-run', null], // resolved from /api/verification run id + first check
  ['datasets', '/api/datasets'],
  ['settings', '/api/settings'],
  ['settings-seat-rates', '/api/settings/seat-rates'],
  ['settings-lob-cg-map', '/api/settings/lob-cg-map'],
  ['access-permissions', '/api/access/permissions'],
  ['access-users', '/api/access/users'],
  ['access-roles', '/api/access/roles'],
  ['access-directory', '/api/access/directory'],
  ['access-events', '/api/access/events'],
  ['auth-session', '/api/auth/session'],
];

// Every call after sign-in sends the session cookie and the csrf header.
let COOKIE = '';
const AUTH_USER = process.env.SMOKE_USER || 'admin';
const AUTH_PASSWORD = process.env.SMOKE_PASSWORD || 'M0nkside';

async function signIn() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aixp-csrf': '1' },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`sign-in as ${AUTH_USER} failed: HTTP ${res.status} ${await res.text()}`);
  COOKIE = res.headers.get('set-cookie').split(';')[0];
}

function shapeOf(v, prefix, out) {
  if (Array.isArray(v)) {
    if (v.length) shapeOf(v[0], prefix + '[]', out);
    else out.add(prefix + '[]*'); // empty array: element keys cannot be checked
    return out;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const p = prefix ? prefix + '.' + k : k;
      out.add(p);
      shapeOf(v[k], p, out);
    }
  }
  return out;
}

// Keys inside maps keyed by data (platform ids, metric names) vary; compare those loosely.
const LOOSE = /(^|\.)(cells|platforms|metrics|counts|defects)\.[^.]+|options\.dataset_name|powerbi\.last_pull\./;

function missingKeys(want, have) {
  const emptyArrays = [...have].filter((k) => k.endsWith('[]*')).map((k) => k.slice(0, -1));
  return [...want].filter((k) => !have.has(k) && !LOOSE.test(k) && !emptyArrays.some((p) => k.startsWith(p)));
}

async function get(url) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(BASE + url, { headers: { cookie: COOKIE, 'x-aixp-csrf': '1' } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, ms, json, text };
}

async function main() {
  await signIn();
  let failed = 0;
  const resolved = {};
  for (const [mockName, fixedRoute] of ROUTES) {
    let route = fixedRoute;
    if (!route) {
      if (mockName === 'model-detail') {
        const m = resolved.models && resolved.models.rows && resolved.models.rows[0];
        route = m ? `/api/models/${encodeURIComponent(m.platform)}/${encodeURIComponent(m.model)}` : null;
      } else if (mockName === 'user-detail') {
        const u = resolved.users && resolved.users.rows && resolved.users.rows[0];
        route = u ? `/api/users/${encodeURIComponent(u.person_key)}` : null;
      } else if (mockName === 'verification-run') {
        const v = resolved.verification;
        const c = v && v.checks && v.checks.find((x) => x.status !== 'skip');
        route = v && v.run && c
          ? `/api/verification/runs/${v.run.id}/checks/${c.id}${c.platform ? '?platform=' + c.platform : ''}`
          : null;
      }
      if (!route) { console.log(`SKIP ${mockName}: could not resolve a route from earlier answers`); failed++; continue; }
    }
    const mockFile = path.join(MOCK, mockName + '.json');
    const mock = fs.existsSync(mockFile) ? JSON.parse(fs.readFileSync(mockFile, 'utf8')) : null;
    let r;
    try { r = await get(route); } catch (e) { console.log(`FAIL ${route}: ${e.message}`); failed++; continue; }
    if (r.status !== 200 || !r.json) { console.log(`FAIL ${route}: HTTP ${r.status} ${r.text.slice(0, 200)}`); failed++; continue; }
    resolved[mockName] = r.json;
    const slow = r.ms > BUDGET_MS;
    let missing = [];
    if (mock) {
      const want = shapeOf(mock, '', new Set());
      const have = shapeOf(r.json, '', new Set());
      missing = missingKeys(want, have);
    }
    const tag = missing.length || slow ? 'WARN' : 'ok  ';
    if (missing.length || slow) failed++;
    console.log(`${tag} ${route}  ${r.ms.toFixed(0)} ms${slow ? ' (over budget)' : ''}${mock ? '' : '  (no mock)'}`);
    for (const k of missing) console.log(`       missing key: ${k}`);
  }
  // Unknown API path must be a JSON 404.
  const nope = await get('/api/nope');
  if (nope.status !== 404 || !nope.json || !nope.json.error) { console.log(`FAIL /api/nope: expected 404 JSON, got ${nope.status}`); failed++; }
  else console.log('ok   /api/nope 404 JSON');
  // CSV export carries the caveat first.
  const csv = await fetch(BASE + '/api/export/summary.csv', { headers: { cookie: COOKIE } }).then((r) => r.text()).catch(() => '');
  if (!csv.startsWith('# This dashboard provides a directional view')) { console.log('FAIL /api/export/summary.csv: caveat line missing'); failed++; }
  else console.log('ok   /api/export/summary.csv caveat first line');
  console.log(failed ? `\n${failed} problem(s)` : '\nall routes match the mock shapes');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
