'use strict';
// Seam check: call every API route the pages use and diff the key structure of the
// answer against the mock file the page was built on (frontend/src/mock/*.json).
// Usage: node scripts/smoke-shapes.js [baseUrl]   (default http://localhost:3090)
// SMOKE_SCOPED=1 adds a second pass signed in as a scoped user (CONTRACT 15.4): it creates the role
// "Scoped smoke" and the user scoped.smoke with a grant for the first LOB-CG value of the active dataset,
// runs every route again under the budget, asserts no person_key or lob_cg outside the grant appears,
// and deletes the user and the role afterwards.
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
  ['vendor-orgs', '/api/vendor-orgs'],
  ['vendors', '/api/vendors'],
  ['vendors-detail', '/api/vendors/detail?vendor=anthropic'],
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

async function get(url, cookie) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(BASE + url, { headers: { cookie: cookie === undefined ? COOKIE : cookie, 'x-aixp-csrf': '1' } });
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
  if (process.env.SMOKE_SCOPED === '1') failed += await scopedPass(resolved);
  console.log(failed ? `\n${failed} problem(s)` : '\nall routes match the mock shapes');
  process.exit(failed ? 1 : 0);
}

async function send(method, url, body, cookie) {
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie: cookie === undefined ? COOKIE : cookie, 'x-aixp-csrf': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text, res };
}

// A key counts as present only as a whole token, so musman2 does not make musman look leaked.
function hasWord(text, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.@-])${esc}([^A-Za-z0-9_.@-]|$)`).test(text);
}

// Walk a parsed answer and report any person_key or lob_cg outside the allowed sets.
function leaks(node, allowKeys, lob, path, out) {
  if (Array.isArray(node)) { node.forEach((v, i) => leaks(v, allowKeys, lob, `${path}[${i}]`, out)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'person_key' && typeof v === 'string' && !allowKeys.has(v) && !/^Total \(/.test(v)) out.push(`${path}.person_key=${v}`);
      if (k === 'lob_cg' && typeof v === 'string' && v !== lob) out.push(`${path}.lob_cg=${v}`);
      leaks(v, allowKeys, lob, `${path}.${k}`, out);
    }
  }
  return out;
}

async function scopedPass(adminResolved) {
  console.log('\n-- scoped pass (SMOKE_SCOPED=1) --');
  let failed = 0;
  const vals = await send('GET', '/api/access/scope-values');
  const first = vals.json && vals.json.values.find((v) => v.in_active_dataset && v.value !== 'Unassigned' && v.people > 0);
  if (!first) { console.log('FAIL no LOB-CG value to grant'); return 1; }
  const lob = first.value;
  // everybody in the dataset, to know whose keys are allowed and whose are not
  const everyone = [];
  for (let page = 1; page < 50; page += 1) {
    const r = await send('GET', `/api/users?pageSize=200&page=${page}&from=2000-01-01&to=2100-01-01`);
    if (!r.json || !r.json.rows.length) break;
    everyone.push(...r.json.rows);
    if (everyone.length >= r.json.total) break;
  }
  const allowKeys = new Set(everyone.filter((u) => u.lob_cg === lob).map((u) => u.person_key));
  const outsiders = everyone.filter((u) => u.lob_cg !== lob).map((u) => u.person_key);
  console.log(`     granting "${lob}" (${allowKeys.size} people in scope, ${outsiders.length} outside)`);

  let roleId = null;
  let userId = null;
  try {
    const perms = ['dashboard.view', 'people.view', 'export.csv'];
    const role = await send('POST', '/api/access/roles', { name: 'Scoped smoke', description: 'smoke test', permissions: perms });
    if (role.status !== 201) { console.log(`FAIL create role: HTTP ${role.status} ${role.text.slice(0, 200)}`); return 1; }
    roleId = role.json.id;
    const pw = 'smoke-scoped-pass-1';
    const user = await send('POST', '/api/access/users', { username: 'scoped.smoke', password: pw, display_name: 'Scoped smoke', role_ids: [roleId], lob_cg: [lob] });
    if (user.status !== 201) { console.log(`FAIL create user: HTTP ${user.status} ${user.text.slice(0, 200)}`); return 1; }
    userId = user.json.id;
    const login = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aixp-csrf': '1' },
      body: JSON.stringify({ username: 'scoped.smoke', password: pw }),
    });
    if (login.status !== 200) { console.log(`FAIL sign in as scoped.smoke: HTTP ${login.status}`); return 1; }
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const routes = ROUTES.map(([name, route]) => {
      let r = route;
      if (!r) {
        const m = adminResolved;
        if (name === 'model-detail') { const x = m.models && m.models.rows[0]; r = x ? `/api/models/${encodeURIComponent(x.platform)}/${encodeURIComponent(x.model)}` : null; }
        else if (name === 'user-detail') { const k = [...allowKeys][0]; r = k ? `/api/users/${encodeURIComponent(k)}` : null; }
      }
      return [name, r];
    }).filter(([, r]) => r);
    // routes a scoped manager must NOT reach (permission or scope), and the status expected
    const denied = {
      settings: 403, 'settings-seat-rates': 403, 'settings-lob-cg-map': 403, 'vendor-orgs': 403, vendors: 403, 'access-permissions': 403, 'access-users': 403,
      'access-roles': 403, 'access-directory': 403, 'access-events': 403, 'verification-run': 403, 'organization-cell': 403,
    };
    // plus the report catalogue and the CSV exports
    const cat = await get('/api/reports', cookie);
    for (const rep of (cat.json && cat.json.reports) || []) routes.push([`report-${rep.id}`, `/api/reports/${rep.id}`]);
    routes.push(['export-users', '/api/export/users.csv'], ['export-platform', '/api/export/platform.csv?platform=anthropic'], ['export-organization', '/api/export/organization.csv']);

    for (const [name, route] of routes) {
      const r = await get(route, cookie);
      const want = denied[name] || 200;
      let problems = [];
      if (r.status !== want) problems.push(`HTTP ${r.status}, expected ${want}`);
      const slow = r.ms > BUDGET_MS;
      if (slow) problems.push(`${r.ms.toFixed(0)} ms over the ${BUDGET_MS} ms budget`);
      if (r.status === 200) {
        if (r.json) problems.push(...leaks(r.json, allowKeys, lob, '$', []).slice(0, 3));
        for (const k of outsiders) if (hasWord(r.text, k)) { problems.push(`response carries outside key ${k}`); break; }
        if (name === 'organization' && r.json) {
          const labels = r.json.rows.map((x) => x.label);
          if (labels.some((l) => l !== lob)) problems.push(`organization rows ${labels.join(', ')}`);
        }
      }
      if (problems.length) failed += 1;
      console.log(`${problems.length ? 'WARN' : 'ok  '} [scoped] ${route}  ${r.ms.toFixed(0)} ms`);
      for (const p of problems) console.log(`       ${p}`);
    }
  } finally {
    if (userId) await send('DELETE', `/api/access/users/${userId}`);
    if (roleId) await send('DELETE', `/api/access/roles/${roleId}`);
    console.log('     scoped.smoke and "Scoped smoke" removed');
  }
  return failed;
}

main().catch((e) => { console.error(e); process.exit(1); });
