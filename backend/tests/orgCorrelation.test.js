'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const staging = require('../src/services/staging');
const { normalize } = require('../src/services/normalize');
const datasets = require('../src/services/datasets');
const org = require('../src/services/orgCorrelation');
const verifyEngine = require('../src/services/verify');
const db = ctx.db.getDb();
const PW = 'a-long-password-1';
let app;
let admin;

const REGION = [{ OfficeCode: 'PHX', Region: 'Americas' }];
const LOB = [
  { job_function: 'Tech', u_lob_2: 'Tech', 'LOB-CG': 'Technology', 'LOB-CG Sort': 1 },
  { job_function: 'Data Analytics', u_lob_2: 'GBS Data Analytics Rotations and Trainin', 'LOB-CG': 'NACG', 'LOB-CG Sort': 2 },
  { job_function: 'Inv', u_lob_2: 'Inv', 'LOB-CG': 'Investment Group', 'LOB-CG Sort': 3 },
  { job_function: 'Legal', u_lob_2: 'Legal and Compliance', 'LOB-CG': 'GBS - L&C', 'LOB-CG Sort': 4 },
];
const person = (key, jf, lob) => ({
  PersonKey: key, email: `${key}@corp.example`, DisplayName: key.toUpperCase(), u_lob_2: lob, job_function: jf,
  OfficeCode: 'PHX', u_bo_fier_sbl: 'Org', u_cg_person_type_code: 'Employee', ExtractAsOf: '2026-10-30',
});
const use = (key, cost) => ({ Date: '2026-10-05', PersonKey: key, Platform: 'Anthropic', Model: 'claude-haiku-4-5', Tokens: 1000, CostUSD: cost, requests: 1 });

function tables() {
  return {
    regionMap: REGION, lobCgMap: LOB, seatRate: [],
    people: [person('p1', 'Tech', 'Tech'), person('p2', 'Inv', 'Inv')],
    usage: [use('p1', 1), use('p2', 2), use('v1', 3), use('v2', 4), use('v3', 5), use('ghost', 6)],
  };
}
function build() {
  const id = staging.createDataset({ label: 'org', source: 'fixture' });
  staging.loadTables(id, tables());
  normalize(id);
  return id;
}

const ORGS = {
  values: [
    { value: 'Technology - Dept', people: [{ person_key: 'v1', email: 'v1@corp.example', display_name: 'V One' }, { person_key: 'p2', email: 'p2@corp.example', display_name: 'P2' }] },
    { value: 'NACG', people: [{ person_key: 'V2 ', email: 'v2@corp.example', display_name: 'V Two' }, { person_key: 'p1', email: 'p1@corp.example', display_name: 'P1' }] },
    { value: 'Tecnology', people: [{ person_key: 'v3', email: 'v3@corp.example', display_name: 'V Three' }] },
    { value: 'Investment  Group (IG)', people: [] },
    { value: 'Zzz Holdings', people: [{ person_key: 'zz', email: 'zz@corp.example', display_name: 'ZZ' }] },
  ],
};
const rowOf = (value) => org.listValues('anthropic').rows.find((r) => r.value === value);

let activeDs;
test.before(async () => {
  activeDs = build();
  datasets.verify(activeDs, { compareTo: null });
  datasets.promote(activeDs, { force: true });
  app = await startApp();
  admin = await app.admin();
});
test.after(async () => {
  if (app) await app.close();
  teardown(ctx);
});

test('normalizeOrg: punctuation, filler words, spacing', () => {
  assert.equal(org.normalizeOrg('TECH2'), 'tech2');
  assert.equal(org.normalizeOrg('Technology - Dept'), 'technology');
  assert.equal(org.normalizeOrg('Investment  Group (IG)'), 'investment ig');
  assert.equal(org.normalizeOrg('The Legal and Compliance Team'), 'legal compliance');
  assert.equal(org.normalizeOrg('GBS - L&C'), 'gbs lc');
  assert.equal(org.normalizeOrg('Line of Business  Operations Org'), 'operations');
  assert.equal(org.normalizeOrg('Group'), 'group');
  assert.equal(org.normalizeOrg(null), '');
});

test('tokenSetRatio and jaroWinkler known values', () => {
  assert.equal(org.tokenSetRatio('a b', 'a b'), 1);
  assert.equal(org.tokenSetRatio('a b', 'b c'), 0.5);
  assert.equal(org.tokenSetRatio('', 'a'), 0);
  assert.equal(org.tokenSetRatio('a a b', 'a b'), 1);
  assert.equal(org.jaroWinkler('', ''), 1);
  assert.equal(org.jaroWinkler('abc', ''), 0);
  assert.equal(org.jaroWinkler('abc', 'xyz'), 0);
  assert.ok(Math.abs(org.jaroWinkler('martha', 'marhta') - 0.9611) < 0.0001);
  assert.ok(Math.abs(org.jaroWinkler('dixon', 'dicksonx') - 0.8133) < 0.0001);
  assert.ok(Math.abs(org.jaroWinkler('dwayne', 'duane') - 0.84) < 0.0001);
});

test('matchValue order: exact, normalized, alias, then fuzzy suggestions that are never applied', () => {
  assert.deepEqual(org.matchValue('anthropic', 'NACG'), { lob_cg: 'NACG', method: 'exact', score: 1, suggestions: [] });
  const n = org.matchValue('anthropic', 'Technology - Dept');
  assert.equal(n.lob_cg, 'Technology');
  assert.equal(n.method, 'normalized');
  assert.equal(org.matchValue('anthropic', 'nacg').method, 'normalized');
  const f = org.matchValue('anthropic', 'Tecnology');
  assert.equal(f.lob_cg, null);
  assert.equal(f.method, null);
  assert.equal(f.suggestions[0].lob_cg, 'Technology');
  assert.ok(f.suggestions[0].score >= 0.8);
  const inv = org.matchValue('anthropic', 'Investment  Group (IG)');
  assert.equal(inv.lob_cg, null);
  assert.equal(inv.suggestions[0].lob_cg, 'Investment Group');
  // Below the 0.80 threshold: nothing suggested.
  assert.deepEqual(org.matchValue('anthropic', 'Zzz Holdings').suggestions, []);
});

test('suggestions are sorted by score with a cap of three', () => {
  const s = org.matchValue('anthropic', 'Tecnology').suggestions;
  assert.ok(s.length >= 1 && s.length <= 3);
  for (let i = 1; i < s.length; i += 1) assert.ok(s[i - 1].score >= s[i].score);
  for (const x of s) assert.ok(x.score >= 0.8 && x.score <= 1);
});

test('ingest upserts values, keeps people, maps exact and normalized only', () => {
  org.ingest('anthropic', ORGS, new Date('2026-11-04T10:00:00Z'));
  const list = org.listValues('anthropic');
  assert.equal(list.rows.length, 5);
  assert.equal(rowOf('Technology - Dept').lob_cg, 'Technology');
  assert.equal(rowOf('Technology - Dept').match_method, 'normalized');
  assert.equal(rowOf('NACG').match_method, 'exact');
  assert.equal(rowOf('NACG').people_count, 2);
  assert.equal(rowOf('Tecnology').lob_cg, null);
  assert.equal(rowOf('Tecnology').suggestions[0].lob_cg, 'Technology');
  assert.equal(rowOf('Investment  Group (IG)').lob_cg, null);
  assert.equal(list.counts.mapped, 2);
  assert.equal(list.counts.unmatched, 3);
  assert.deepEqual(list.lob_values.map((l) => l.value), ['Technology', 'NACG', 'Investment Group', 'GBS - L&C']);
  // Person keys are lowercased and trimmed.
  assert.ok(db.prepare("SELECT 1 FROM vendor_org_people WHERE vendor = 'anthropic' AND person_key = 'v2'").get());
  // first_seen is kept, last_seen moves.
  const first = db.prepare("SELECT first_seen_at FROM vendor_org_values WHERE value = 'NACG'").get().first_seen_at;
  org.ingest('anthropic', ORGS, new Date('2026-11-05T10:00:00Z'));
  const r = db.prepare("SELECT first_seen_at, last_seen_at FROM vendor_org_values WHERE value = 'NACG'").get();
  assert.equal(r.first_seen_at, first);
  assert.equal(r.last_seen_at, '2026-11-05T10:00:00.000Z');
  // People for the vendor are replaced on the next ingest.
  org.ingest('anthropic', { values: [{ value: 'NACG', people: [{ person_key: 'v2', email: 'v2@corp.example', display_name: 'V Two' }] }] }, new Date('2026-11-06T10:00:00Z'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM vendor_org_people WHERE vendor = 'anthropic'").get().n, 1);
  assert.equal(rowOf('NACG').people_count, 1);
  assert.equal(rowOf('Tecnology').people_count, 0);
  org.ingest('anthropic', ORGS, new Date('2026-11-07T10:00:00Z'));
  assert.equal(rowOf('Tecnology').people_count, 1);
});

test('confirm, alias and clear; confirmed mappings survive a pull', () => {
  const id = rowOf('Tecnology').id;
  assert.throws(() => org.setMapping(id, 'Not A Label', 'manual', 1), /not a LOB-CG value/);
  const out = org.setMapping(id, 'Technology', 'fuzzy_confirmed', 1);
  assert.equal(out.row.lob_cg, 'Technology');
  assert.equal(out.row.match_method, 'fuzzy_confirmed');
  assert.equal(out.row.confirmed_by.id, 1);
  org.ingest('anthropic', ORGS, new Date('2026-11-08T10:00:00Z'));
  assert.equal(rowOf('Tecnology').match_method, 'fuzzy_confirmed');
  const cleared = org.setMapping(id, null, undefined, 1);
  assert.equal(cleared.row.lob_cg, null);
  assert.equal(cleared.row.match_method, null);
  // Alias: maps the normalized form on the next evaluation; removing it unmaps again.
  const a = org.addAlias('  ZZZ Holdings!! ', 'Investment Group', 1);
  assert.equal(a.alias, 'zzz holdings');
  assert.throws(() => org.addAlias('zzz holdings', 'Investment Group', 1), /already exists/);
  assert.throws(() => org.addAlias('x', 'Nope', 1), /not a LOB-CG value/);
  org.ingest('anthropic', ORGS, new Date('2026-11-09T10:00:00Z'));
  assert.equal(rowOf('Zzz Holdings').lob_cg, 'Investment Group');
  assert.equal(rowOf('Zzz Holdings').match_method, 'alias');
  org.removeAlias(a.id);
  assert.equal(rowOf('Zzz Holdings').lob_cg, null);
  org.setMapping(id, 'Technology', 'manual', 1);
  assert.equal(rowOf('Tecnology').match_method, 'manual');
});

test('a renamed label is caught: exact and normalized mappings are re-evaluated on every pull', () => {
  db.prepare("UPDATE lob_cg_map SET lob_cg = 'Tech Org' WHERE dataset_id = ? AND lob_cg = 'NACG'").run(activeDs);
  db.prepare("UPDATE people SET lob_cg = 'Tech Org' WHERE dataset_id = ? AND lob_cg = 'NACG'").run(activeDs);
  org.ingest('anthropic', ORGS, new Date('2026-11-10T10:00:00Z'));
  assert.equal(rowOf('NACG').lob_cg, null);
  db.prepare("UPDATE lob_cg_map SET lob_cg = 'NACG' WHERE dataset_id = ? AND lob_cg = 'Tech Org'").run(activeDs);
  db.prepare("UPDATE people SET lob_cg = 'NACG' WHERE dataset_id = ? AND lob_cg = 'Tech Org'").run(activeDs);
  org.ingest('anthropic', ORGS, new Date('2026-11-11T10:00:00Z'));
  assert.equal(rowOf('NACG').match_method, 'exact');
});

test('normalize applies vendor orgs: people only for unmatched keys, extract rows untouched', () => {
  const id = build();
  const people = db.prepare('SELECT * FROM people WHERE dataset_id = ? ORDER BY person_key').all(id);
  const by = Object.fromEntries(people.map((p) => [p.person_key, p]));
  assert.deepEqual(Object.keys(by).sort(), ['p1', 'p2', 'v1', 'v2', 'v3']);
  assert.equal(by.p1.origin, 'extract');
  assert.equal(by.p1.lob_cg, 'Technology');
  assert.equal(by.p2.origin, 'extract');
  assert.equal(by.p2.lob_cg, 'Investment Group');
  assert.equal(by.v1.origin, 'vendor');
  assert.equal(by.v1.lob_cg, 'Technology');
  assert.equal(by.v1.lob_cg_sort, 1);
  assert.equal(by.v1.email, 'v1@corp.example');
  assert.equal(by.v1.display_name, 'V One');
  assert.equal(by.v1.region, 'Unknown');
  assert.equal(by.v2.lob_cg, 'NACG');
  assert.equal(by.v2.lob_cg_sort, 2);
  assert.equal(by.v3.origin, 'vendor'); // v3 sits in Tecnology, which was manually mapped above
  const matched = Object.fromEntries(db.prepare('SELECT person_key, matched FROM usage WHERE dataset_id = ?').all(id).map((r) => [r.person_key, r.matched]));
  assert.equal(matched.v1, 1);
  assert.equal(matched.ghost, 0);
  assert.equal(datasets.get(id).counts.people_vendor, 3);
  assert.equal(datasets.get(activeDs).counts.people_vendor, 0);
});

test('multi-membership: the first mapped value by lob_cg_sort wins', () => {
  org.ingest('anthropic', {
    values: [
      { value: 'NACG', people: [{ person_key: 'v1', email: 'v1@corp.example', display_name: 'V One' }] },
      { value: 'Technology - Dept', people: [{ person_key: 'v1', email: 'v1@corp.example', display_name: 'V One' }] },
    ],
  }, new Date('2026-11-12T10:00:00Z'));
  const id = build();
  assert.equal(db.prepare("SELECT lob_cg FROM people WHERE dataset_id = ? AND person_key = 'v1'").get(id).lob_cg, 'Technology');
  org.ingest('anthropic', ORGS, new Date('2026-11-13T10:00:00Z'));
});

test('verification: unmatched (warn) and disagreement (info, extract never changed)', () => {
  const id = build();
  const res = verifyEngine.run({ db, datasetId: id, prevDatasetId: null, settings: {}, today: '2026-11-13' }).results;
  const unm = res.find((r) => r.check_id === 'vendor_org_unmatched');
  assert.equal(unm.severity, 'warn');
  assert.equal(unm.status, 'fail');
  assert.equal(unm.evidence.columns[0], 'value');
  const vals = unm.evidence.rows.map((r) => r[0]);
  assert.ok(vals.includes('Zzz Holdings'));
  assert.ok(!vals.includes('NACG'));
  const dis = res.find((r) => r.check_id === 'vendor_org_disagreement');
  assert.equal(dis.severity, 'info');
  assert.equal(dis.status, 'pass');
  // p2 is Investment Group in the extract and sits in Technology - Dept (maps to Technology).
  const hit = dis.evidence.rows.find((r) => r[0] === 'p2');
  assert.ok(hit);
  assert.equal(hit[1], 'Investment Group');
  assert.equal(hit[3], 'Technology');
  assert.equal(db.prepare("SELECT lob_cg FROM people WHERE dataset_id = ? AND person_key = 'p2'").get(id).lob_cg, 'Investment Group');
});

test('routes: settings.manage gate, listing, PUT validation, aliases, apply, people, CSV, audit event', async () => {
  assert.equal((await app.call('GET', '/api/vendor-orgs')).status, 401);
  const analyst = db.prepare("SELECT id FROM roles WHERE name = 'Analyst'").get().id;
  const mk = await admin.call('POST', '/api/access/users', { username: 'ana', display_name: 'Ana', password: PW, role_ids: [analyst] });
  assert.equal(mk.status, 201, mk.text);
  const ana = await app.login('ana', PW);
  assert.equal((await ana.call('GET', '/api/vendor-orgs')).status, 403);
  assert.equal((await ana.call('PUT', '/api/vendor-orgs/1', { lob_cg: null })).status, 403);

  const list = await admin.call('GET', '/api/vendor-orgs?vendor=anthropic');
  assert.equal(list.status, 200);
  const r = list.json.rows.find((x) => x.value === 'Zzz Holdings');
  assert.ok(r.id && r.vendor === 'anthropic' && Array.isArray(r.suggestions) && 'confirmed_by' in r && r.last_seen_at);
  assert.ok(Array.isArray(list.json.lob_values) && Array.isArray(list.json.aliases));
  assert.deepEqual(Object.keys(list.json.counts).sort(), ['mapped', 'people_unmatched', 'unmatched']);

  const bad = await admin.call('PUT', `/api/vendor-orgs/${r.id}`, { lob_cg: 'Nowhere' });
  assert.equal(bad.status, 400);
  assert.equal((await admin.call('PUT', '/api/vendor-orgs/999999', { lob_cg: null })).status, 404);
  assert.equal((await admin.call('PUT', `/api/vendor-orgs/${r.id}`, {})).status, 400);

  const before = db.prepare("SELECT count(*) AS n FROM auth_events WHERE kind = 'org_map_changed'").get().n;
  const ok = await admin.call('PUT', `/api/vendor-orgs/${r.id}`, { lob_cg: 'GBS - L&C', method: 'manual' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.lob_cg, 'GBS - L&C');
  assert.equal(ok.json.match_method, 'manual');
  assert.equal(ok.json.confirmed_by.username, 'admin');
  const ev = db.prepare("SELECT * FROM auth_events WHERE kind = 'org_map_changed' ORDER BY id DESC").get();
  assert.equal(db.prepare("SELECT count(*) AS n FROM auth_events WHERE kind = 'org_map_changed'").get().n, before + 1);
  assert.ok(ev.actor_user_id);
  assert.match(ev.detail, /Zzz Holdings/);
  const cl = await admin.call('PUT', `/api/vendor-orgs/${r.id}`, { lob_cg: null });
  assert.equal(cl.json.lob_cg, null);

  const al = await admin.call('POST', '/api/vendor-orgs/aliases', { alias: 'Zzz Holdings Inc', lob_cg: 'GBS - L&C' });
  assert.equal(al.status, 201);
  assert.equal((await admin.call('POST', '/api/vendor-orgs/aliases', { alias: 'zzz holdings inc', lob_cg: 'GBS - L&C' })).status, 409);
  assert.equal((await admin.call('POST', '/api/vendor-orgs/aliases', { alias: 'q', lob_cg: 'Nowhere' })).status, 400);
  assert.equal((await admin.call('DELETE', `/api/vendor-orgs/aliases/${al.json.id}`)).status, 200);
  assert.equal((await admin.call('DELETE', `/api/vendor-orgs/aliases/${al.json.id}`)).status, 404);

  const ppl = await admin.call('GET', `/api/vendor-orgs/${rowOf('Technology - Dept').id}/people`);
  assert.equal(ppl.status, 200);
  const p2 = ppl.json.rows.find((x) => x.person_key === 'p2');
  assert.equal(p2.in_extract, true);
  assert.equal(p2.extract_lob_cg, 'Investment Group');
  const v1 = ppl.json.rows.find((x) => x.person_key === 'v1');
  assert.equal(v1.in_extract, false);

  const ap = await admin.call('POST', '/api/vendor-orgs/apply');
  assert.equal(ap.status, 200);
  assert.ok(ap.json.people_created >= 2);
  assert.equal(db.prepare("SELECT origin FROM people WHERE dataset_id = ? AND person_key = 'v1'").get(activeDs).origin, 'vendor');
  const again = await admin.call('POST', '/api/vendor-orgs/apply');
  assert.equal(again.json.people_created, 0);

  const csv = await admin.call('GET', '/api/vendor-orgs/export.csv?vendor=anthropic');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.split('\r\n');
  assert.match(lines[0], /^# /);
  assert.equal(lines[1], 'vendor,value,normalized,lob_cg,match_method,score,people_count,confirmed_by,confirmed_at,last_seen_at');
  assert.ok(lines.some((l) => l.includes('Zzz Holdings')));

  // /api/users rows and userDetail carry origin.
  const users = await admin.call('GET', '/api/users?pageSize=200&from=2026-10-01&to=2026-10-31');
  assert.equal(users.status, 200);
  const u = users.json.rows.find((x) => x.person_key === 'v1');
  assert.equal(u.origin, 'vendor');
  assert.equal(users.json.rows.find((x) => x.person_key === 'p1').origin, 'extract');
  const det = await admin.call('GET', '/api/users/v1?from=2026-10-01&to=2026-10-31');
  assert.equal(det.json.person.origin, 'vendor');
});
