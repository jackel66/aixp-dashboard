'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers');

const ctx = setup();
const staging = require('../src/services/staging');
const { normalize, parseDate, parseNum } = require('../src/services/normalize');
const db = ctx.db.getDb();
test.after(() => teardown(ctx));

function build(tables) {
  const id = staging.createDataset({ label: 'unit', source: 'fixture' });
  staging.loadTables(id, tables);
  const counts = normalize(id);
  return { id, counts };
}

const REGION = [{ OfficeCode: 'PHX', Region: 'Americas' }, { OfficeCode: 'LON', Region: 'EMEA' }];
const LOB = [
  { job_function: 'Legal', u_lob_2: 'Legal and Compliance', 'LOB-CG': 'GBS - L&C', 'LOB-CG Sort': 4 },
  { job_function: 'Data Analytics', u_lob_2: 'GBS Data Analytics Rotations and Trainin', 'LOB-CG': 'NACG', 'LOB-CG Sort': 2 },
];

test('headerKey strips wrappers and resolves synonyms', () => {
  const { headerKey } = staging;
  assert.equal(headerKey('Usage[PersonKey]'), 'person_key');
  assert.equal(headerKey('  Person  Key '), 'person_key');
  assert.equal(headerKey('alias'), 'person_key');
  assert.equal(headerKey('amount_usd'), 'cost_usd');
  assert.equal(headerKey('CostUSD'), 'cost_usd');
  assert.equal(headerKey('gross_amount'), 'cost_usd');
  assert.equal(headerKey('Monthly credits used'), 'credits');
  assert.equal(headerKey('LOB-CG Sort'), 'lob_cg_sort');
  assert.equal(headerKey('User ID'), 'user_id');
  assert.equal(headerKey('u_lob_2'), 'u_lob_2');
  assert.equal(headerKey('Some Odd Header'), 'some_odd_header');
});

test('date and number parsing', () => {
  assert.equal(parseDate('2026-10-05'), '2026-10-05');
  assert.equal(parseDate('2026-10-05T13:45:00Z'), '2026-10-05');
  assert.equal(parseDate('10/5/2026'), '2026-10-05');
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('13/40/2026'), null);
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum('  '), null);
  assert.equal(parseNum('1.5e-3'), 0.0015);
  assert.equal(parseNum('12abc'), undefined);
});

test('stage tables hold the text exactly as given', () => {
  const id = staging.createDataset({ label: 'raw' });
  staging.loadTables(id, {
    usage: [{ Date: '2026-10-05', PersonKey: 'JSmith\u00a0', Platform: 'Anthropic', Tokens: 12, CostUSD: 0.5, Extra: 'x' }],
    people: [], seatRate: [], regionMap: [], lobCgMap: [],
  });
  const r = db.prepare('SELECT * FROM stage_usage WHERE dataset_id = ?').get(id);
  assert.equal(r.person_key, 'JSmith\u00a0');
  assert.equal(r.tokens, '12');
  assert.equal(r.cost_usd, '0.5');
  assert.deepEqual(JSON.parse(r.extra_json), { Extra: 'x' });
});

test('usage keys are normalized before anything else; blanks, rejects and github alias', () => {
  const { id, counts } = build({
    regionMap: REGION,
    lobCgMap: LOB,
    people: [{ PersonKey: 'jsmith', email: 'J.Smith@Corp.Example ', DisplayName: 'J Smith', u_lob_2: 'Legal and Compliance', job_function: 'Legal', OfficeCode: 'PHX', u_bo_fier_sbl: 'Org', u_cg_person_type_code: 'Employee', ExtractAsOf: '2026-10-30' }],
    seatRate: [],
    usage: [
      { Date: '2026-10-05', PersonKey: 'JSmith\u00a0', Platform: 'Anthropic', Model: 'claude-haiku-4-5', Tokens: 1000, CostUSD: 0.01, requests: 2 },
      { Date: '2026-10-05', PersonKey: 'jsmith_capgroup', Platform: 'GitHub Copilot', Credits: 10, CostUSD: 0.4, discount_amount: 0.1, net_amount: 0.3 },
      { Date: '2026-10-05', PersonKey: '\u00a0 ', Platform: 'OpenAI', Model: 'gpt-5', Tokens: 5, CostUSD: 0.1 },
      { Date: '2026-10-06', PersonKey: 'ghost', Platform: 'OpenAI', Model: 'gpt-5', Tokens: 5, CostUSD: 0.1, Credits: 2 },
      { Date: 'garbage', PersonKey: 'jsmith', Platform: 'OpenAI', Tokens: 5, CostUSD: 0.1 },
      { Date: '2026-10-06', PersonKey: 'jsmith', Platform: 'OpenAI', Tokens: 'abc', CostUSD: 0.1 },
      { Date: '2026-10-06', PersonKey: 'jsmith', Platform: 'Mystery', Tokens: 5, CostUSD: 0.1 },
      { Date: '10/7/2026', PersonKey: 'jsmith', Platform: 'OpenAI', Model: 'o3', Tokens: '', CostUSD: 0.2 },
    ],
  });
  const rows = db.prepare('SELECT * FROM usage WHERE dataset_id = ? ORDER BY id').all(id);
  assert.equal(rows.length, 4);
  const [a, g, ghost, c] = rows;
  assert.equal(a.person_key, 'jsmith');
  assert.equal(a.platform, 'anthropic');
  assert.equal(a.matched, 1);
  assert.equal(a.consumption_unit, 'tokens');
  assert.equal(a.consumption, 1000);
  assert.equal(a.requests, 2);
  assert.equal(g.person_key, 'jsmith');
  assert.equal(g.consumption_unit, 'credits');
  assert.equal(g.consumption, 10);
  assert.equal(g.model, '');
  assert.equal(g.discount_amount, 0.1);
  assert.equal(ghost.matched, 0);
  assert.equal(ghost.credits, 2);
  assert.equal(c.date, '2026-10-07');
  assert.equal(c.tokens, 0);
  assert.equal(counts.droppedBlankKey, 1);
  assert.equal(counts.rejected.count, 3);
  assert.equal(counts.rejected.samples.length, 3);
  assert.deepEqual(counts.rejected.samples.map((s) => s.reason), ['bad date', 'non-numeric value', 'unknown platform']);
  assert.equal(counts.byPlatform.openai.rejected, 2);
  assert.equal(counts.byPlatform.openai.droppedBlankKey, 1);
  const stored = JSON.parse(db.prepare('SELECT counts_json FROM datasets WHERE id = ?').get(id).counts_json);
  assert.equal(stored.droppedBlankKey, 1);
});

test('cowork keeps the latest snapshot per person and month, valued at the cowork rate', () => {
  const { id, counts } = build({
    regionMap: [], lobCgMap: [], people: [], seatRate: [],
    usage: [
      { Date: '2026-10-01', PersonKey: 'a', Platform: 'Copilot Cowork', Credits: 100, email: 'a@corp.example' },
      { Date: '2026-10-09', PersonKey: 'a', Platform: 'Copilot Cowork', Credits: 400, email: 'a@corp.example' },
      { Date: '2026-10-20', PersonKey: 'a', Platform: 'Copilot Cowork', Credits: 900, email: 'a@corp.example' },
      { Date: '2026-11-02', PersonKey: 'a', Platform: 'Copilot Cowork', Credits: 50, email: 'a@corp.example' },
      { Date: '2026-10-05', PersonKey: 'b', Platform: 'Copilot Cowork', Credits: 10 },
    ],
  });
  const rows = db.prepare("SELECT * FROM usage WHERE dataset_id = ? AND platform = 'cowork' ORDER BY person_key, date").all(id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.person_key, r.date, r.credits]), [['a', '2026-10-20', 900], ['a', '2026-11-02', 50], ['b', '2026-10-05', 10]]);
  assert.equal(rows[0].cost_usd, 7.2);
  assert.equal(rows[0].cost_source, 'derived');
  assert.equal(rows[0].snapshot_rank, 1);
  assert.equal(rows[0].consumption_unit, 'credits');
  assert.equal(counts.coworkSnapshotsDropped, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM stage_usage WHERE dataset_id = ? AND platform = 'Copilot Cowork'").get(id).n, 5);
});

test('people: newest extract wins, blank LOB retained, unassigned and unknown fallbacks', () => {
  const { id } = build({
    regionMap: REGION, lobCgMap: LOB, usage: [], seatRate: [],
    people: [
      { PersonKey: 'Al\u00a0', email: 'AL@corp.example', 'User ID': 'u1', DisplayName: 'Al', u_lob_2: 'Legal and Compliance', job_function: 'Legal', OfficeCode: 'phx', u_bo_fier_sbl: 'Old Org', u_cg_person_type_code: 'Employee', ExtractAsOf: '2026-09-01' },
      { PersonKey: 'al', email: 'al@corp.example', 'User ID': 'u1', DisplayName: 'Al', u_lob_2: '', job_function: 'Legal', OfficeCode: 'PHX', u_bo_fier_sbl: 'New Org', u_cg_person_type_code: 'Employee', ExtractAsOf: '2026-10-01' },
      { PersonKey: 'bo', email: 'bo@corp.example', DisplayName: 'Bo', u_lob_2: 'GBS Data Analytics Rotations and Trainin', job_function: 'Data Analytics', OfficeCode: 'ZZ9', u_bo_fier_sbl: '', u_cg_person_type_code: 'Contractor', ExtractAsOf: '10/1/2026' },
      { PersonKey: 'cy', DisplayName: 'Cy', u_lob_2: 'Unmapped', job_function: 'Nothing', OfficeCode: 'LON', u_cg_person_type_code: '', ExtractAsOf: '2026-10-01' },
      { PersonKey: ' ', DisplayName: 'Blank' },
      { PersonKey: 'dee', DisplayName: 'Dee', u_lob_2: 'Legal and Compliance', job_function: 'Legal', ExtractAsOf: '2026-10-01' },
      { PersonKey: 'dee', DisplayName: 'Dee', u_lob_2: '', job_function: 'Legal', ExtractAsOf: '2026-10-01' },
    ],
  });
  const p = Object.fromEntries(db.prepare('SELECT * FROM people WHERE dataset_id = ?').all(id).map((r) => [r.person_key, r]));
  assert.deepEqual(Object.keys(p).sort(), ['al', 'bo', 'cy', 'dee']);
  assert.equal(p.al.sbl, 'New Org');
  assert.equal(p.al.u_lob_2, '');
  assert.equal(p.al.lob_cg, 'Unassigned');
  assert.equal(p.al.lob_cg_sort, 999);
  assert.equal(p.al.region, 'Americas');
  assert.equal(p.al.user_id, 'U1');
  assert.equal(p.al.person_type, 'Associate');
  assert.equal(p.bo.lob_cg, 'NACG');
  assert.equal(p.bo.lob_cg_sort, 2);
  assert.equal(p.bo.region, 'Unknown');
  assert.equal(p.bo.office_code, 'ZZ9');
  assert.equal(p.bo.person_type, 'Non-Associate');
  assert.equal(p.cy.lob_cg, 'Unassigned');
  assert.equal(p.cy.person_type, 'Unknown');
  assert.equal(p.cy.region, 'EMEA');
  assert.equal(p.dee.u_lob_2, 'Legal and Compliance', 'tie on extract date prefers the row with u_lob_2');
  assert.equal(p.dee.lob_cg, 'GBS - L&C');
});

test('seat rate, region map and lob map are normalized', () => {
  const { id } = build({
    regionMap: [{ OfficeCode: ' phx ', Region: 'Americas' }, { OfficeCode: 'PHX', Region: 'Other' }],
    lobCgMap: LOB, usage: [], people: [],
    seatRate: [
      { Platform: 'GitHub Copilot', Month: '2026-10', RateUSD: 19, LicensedSeats: 300 },
      { Platform: 'Nope', Month: '2026-10', RateUSD: 1, LicensedSeats: 1 },
    ],
  });
  assert.deepEqual(db.prepare('SELECT office_code, region FROM region_map WHERE dataset_id = ?').all(id), [{ office_code: 'PHX', region: 'Americas' }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lob_cg_map WHERE dataset_id = ?').get(id).n, 2);
  assert.deepEqual(db.prepare('SELECT platform, month, rate_usd, licensed_seats FROM seat_rate WHERE dataset_id = ?').all(id),
    [{ platform: 'github', month: '2026-10', rate_usd: 19, licensed_seats: 300 }]);
});

test('normalize is repeatable', () => {
  const { id } = build({
    regionMap: REGION, lobCgMap: LOB, seatRate: [],
    people: [{ PersonKey: 'x', DisplayName: 'X', ExtractAsOf: '2026-10-01' }],
    usage: [{ Date: '2026-10-05', PersonKey: 'x', Platform: 'OpenAI', Model: 'gpt-5', Tokens: 5, CostUSD: 0.1 }],
  });
  normalize(id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ?').get(id).n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM people WHERE dataset_id = ?').get(id).n, 1);
});
