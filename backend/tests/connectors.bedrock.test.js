'use strict';
// AWS Bedrock connector (CONTRACT section 19.3) against one fake AWS endpoint that serves every service the
// SDK clients talk to: CloudWatch Logs and Cost Explorer (JSON 1.1, dispatched on X-Amz-Target), CloudWatch
// (JSON 1.0 in this SDK version, not the query protocol), STS (query protocol, XML) and Bedrock (REST JSON).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setup, teardown, startApp } = require('./helpers');

const ACCESS_KEY = 'AKIATESTKEY0123456789';
const SECRET = 'TESTSECRETaccessKEY0123456789abcdefghij';
const BAD_KEY = 'AKIANOTREALKEY00000';
const BAD_SECRET = 'bogusbogusbogusbogusbogusbogusbogus1234';
const GROUP = '/aws/bedrock/test';
process.env.AIXP_SECRET_KEY = 'd4'.repeat(32);

const ctx = setup();
const db = ctx.db.getDb();
const { seedFixture } = require('./seed');
const aws = require('../src/services/connectors/awsClient');
const bedrock = require('../src/services/connectors/bedrock');
const connectors = require('../src/services/connectors');
const settings = require('../src/services/settings');
const datasets = require('../src/services/datasets');
const time = require('../src/services/time');

const NOW = '2026-11-04T08:30:00Z';
const FROM = '2026-10-01';
const TO = '2026-11-04T08:00:00.000Z';
const DATA_DAYS = 20; // log data on 2026-10-01 .. 2026-10-20
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
const dayStr = (d) => new Date(Date.parse('2026-10-01T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);

const CLAUDE_X = 'us.anthropic.claude-sonnet-4-6-20260301-v1:0'; // cross-Region id
const CLAUDE = 'anthropic.claude-sonnet-4-6-20260301-v1:0';
const NOVA = 'amazon.nova-2-lite-v1:0';

// ---- fake data ------------------------------------------------------------------------------

const fake = {
  server: null, base: '',
  logsCalls: [], ceCalls: [], cwCalls: [], stsCalls: [], bedrockCalls: [], creds: [],
  queryOutcome: new Map(), polls: new Map(),
  throttleStart: 0, denyLogs: false, loggingConfig: null, groups: [GROUP], metadataMode: false, assumeKeyUsed: false,
  logEvents: [], ce: [], metricModels: [], pageSize: 4, cePerPage: 3, firstEvent: '2026-09-02 10:00:00.000',
};

function genLogs(email1, login2) {
  const rows = [];
  for (let d = 0; d < DATA_DAYS; d++) {
    const day = dayStr(d);
    const a1 = `arn:aws:sts::123456789012:assumed-role/DevRole/${email1}`;
    const a2 = `arn:aws:sts::123456789012:assumed-role/DevRole/${login2}`;
    rows.push({ day, arn: a1, who: email1.toUpperCase(), model: CLAUDE_X, inp: 1000 + d, out: 200, req: 3 });
    if (d % 2 === 0) rows.push({ day, arn: a1, who: email1.toUpperCase(), model: CLAUDE, inp: 500, out: 100, req: 2 });
    rows.push({ day, arn: a2, who: login2.toUpperCase(), model: CLAUDE, inp: 2000, out: 400, req: 5 });
    rows.push({ day, arn: a2, who: login2.toUpperCase(), model: NOVA, inp: 300, out: 100, req: 1 });
    rows.push({ day, arn: 'arn:aws:iam::123456789012:user/ops/svc-batch', who: 'Svc-Batch', model: NOVA, inp: 800, out: 200, req: 4 });
    if (d === 2) rows.push({ day, arn: '', who: '', model: NOVA, inp: 100, out: 50, req: 1 });
  }
  return rows;
}

function genCe() {
  const rows = [];
  for (let d = 0; d < DATA_DAYS; d++) {
    const day = dayStr(d);
    rows.push({ day, ut: 'USE1-Claude4.6Sonnet-input-tokens', usd: 2 + d * 0.01 });
    rows.push({ day, ut: 'USE1-Claude4.6Sonnet-output-tokens', usd: 4 });
    rows.push({ day, ut: 'USE1-Nova2.0Lite-input-tokens', usd: 0.5 });
    rows.push({ day, ut: 'USE1-Nova2.0Lite-output-tokens', usd: 0.8 });
  }
  rows.push({ day: '2026-10-25', ut: 'USE1-Claude4.6Sonnet-input-tokens', usd: 1.5 }); // dollars, no log rows that day
  rows.push({ day: '2026-10-05', ut: 'USE1-Titan-Text-Express-input-tokens', usd: 0.25 }); // matches no model
  return rows;
}

// ---- fake server ----------------------------------------------------------------------------

const ERR_JSON = (res, status, type, message) => res.status(status).set('x-amzn-errortype', type).type('application/x-amz-json-1.1').send(JSON.stringify({ __type: type, message }));
const authKey = (req) => {
  const m = /Credential=([A-Z0-9]+)\//.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
};

function rowsFor(startSec, endSec, qs) {
  const m = /limit (\d+)/.exec(qs);
  const cap = m ? Number(m[1]) : 100000;
  const out = [];
  for (const e of fake.logEvents) {
    const t = Date.parse(`${e.day}T00:00:00Z`) / 1000;
    if (t + 86399 < startSec || t > endSec) continue;
    const f = [{ field: 'day', value: `${e.day} 00:00:00.000` }];
    if (qs.includes(' as who')) f.push({ field: 'who', value: e.who }); else f.push({ field: 'arn', value: e.arn });
    f.push({ field: 'model', value: e.model }, { field: 'input_tokens', value: String(e.inp) }, { field: 'output_tokens', value: String(e.out) }, { field: 'requests', value: String(e.req) }, { field: '@ptr', value: 'zz' });
    out.push(f);
  }
  return out.slice(0, cap);
}

function logsOp(op, body, req, res) {
  fake.logsCalls.push({ op, body, key: authKey(req) });
  if (fake.denyLogs && op !== 'DescribeLogGroups') return ERR_JSON(res, 400, 'AccessDeniedException', 'User is not authorized to perform: logs:StartQuery');
  const send = (o) => res.type('application/x-amz-json-1.1').send(JSON.stringify(o));
  if (op === 'DescribeLogGroups') return send({ logGroups: fake.groups.filter((g) => g.startsWith(body.logGroupNamePrefix || '')).map((g) => ({ logGroupName: g, creationTime: Date.parse('2026-09-01T00:00:00Z') })) });
  if (op === 'StartQuery') {
    if (fake.throttleStart > 0) { fake.throttleStart -= 1; return ERR_JSON(res, 400, 'ThrottlingException', 'Rate exceeded'); }
    const id = `q${fake.logsCalls.length}`;
    let rows;
    if (body.queryString.includes('min(@timestamp)')) rows = [[{ field: 'first_event', value: fake.firstEvent }]];
    else rows = rowsFor(body.startTime, body.endTime, body.queryString);
    fake.queryOutcome.set(id, { rows, body });
    fake.polls.set(id, 0);
    return send({ queryId: id });
  }
  if (op === 'GetQueryResults') {
    const q = fake.queryOutcome.get(body.queryId);
    if (!q) return ERR_JSON(res, 400, 'ResourceNotFoundException', 'unknown query');
    const polls = fake.polls.get(body.queryId);
    fake.polls.set(body.queryId, polls + 1);
    if (polls === 0 && !body.nextToken) return send({ status: 'Running', results: [] });
    const start = body.nextToken ? Number(Buffer.from(body.nextToken, 'base64url').toString('utf8')) : 0;
    const slice = q.rows.slice(start, start + fake.pageSize);
    const more = start + fake.pageSize < q.rows.length;
    return send({ status: 'Complete', results: slice, nextToken: more ? Buffer.from(String(start + fake.pageSize)).toString('base64url') : undefined });
  }
  if (op === 'StopQuery') return send({ success: true });
  return ERR_JSON(res, 400, 'UnknownOperationException', op);
}

function ceOp(body, req, res) {
  fake.ceCalls.push({ body, key: authKey(req) });
  if (fake.denyLogs && fake.denyCe) return ERR_JSON(res, 400, 'AccessDeniedException', 'User is not authorized to perform: ce:GetCostAndUsage');
  const start = body.TimePeriod.Start;
  const end = body.TimePeriod.End;
  const days = [...new Set(fake.ce.filter((r) => r.day >= start && r.day < end).map((r) => r.day))].sort();
  const from = body.NextPageToken ? Number(body.NextPageToken) : 0;
  const page = days.slice(from, from + fake.cePerPage);
  const next = from + fake.cePerPage < days.length ? String(from + fake.cePerPage) : undefined;
  const results = page.map((day) => ({
    TimePeriod: { Start: day, End: day }, Total: {}, Estimated: false,
    Groups: fake.ce.filter((r) => r.day === day).map((r) => ({ Keys: [r.ut], Metrics: { UnblendedCost: { Amount: String(r.usd), Unit: 'USD' } } })),
  }));
  return res.type('application/x-amz-json-1.1').send(JSON.stringify({ ResultsByTime: results, NextPageToken: next }));
}

function cwOp(op, body, req, res) {
  fake.cwCalls.push({ op, body, key: authKey(req) });
  const send = (o) => res.type('application/x-amz-json-1.0').send(JSON.stringify(o));
  if (op === 'ListMetrics') {
    const from = body.NextToken ? Number(body.NextToken) : 0;
    const page = fake.metricModels.slice(from, from + 2);
    return send({
      Metrics: page.map((m) => ({ Namespace: 'AWS/Bedrock', MetricName: body.MetricName, Dimensions: [{ Name: 'ModelId', Value: m }] })),
      NextToken: from + 2 < fake.metricModels.length ? String(from + 2) : undefined,
    });
  }
  if (op === 'GetMetricData') {
    const startSec = Number(body.StartTime);
    const results = body.MetricDataQueries.map((q) => {
      const model = q.MetricStat.Metric.Dimensions[0].Value;
      const idx = fake.metricModels.indexOf(model) + 1;
      const name = q.MetricStat.Metric.MetricName;
      const stamps = [];
      const vals = [];
      for (let d = 0; d < 3; d++) {
        stamps.push(startSec + d * 86400);
        vals.push(name === 'InputTokenCount' ? 1000 * idx : name === 'OutputTokenCount' ? 200 * idx : 3);
      }
      return { Id: q.Id, Label: name, Timestamps: stamps, Values: vals, StatusCode: 'Complete' };
    });
    return send({ MetricDataResults: results, Messages: [] });
  }
  return ERR_JSON(res, 400, 'UnknownOperationException', op);
}

function stsOp(body, req, res) {
  const p = new URLSearchParams(body);
  const action = p.get('Action');
  const key = authKey(req);
  fake.stsCalls.push({ action, key });
  const xml = (inner) => res.type('text/xml').send(inner);
  if (key === BAD_KEY) {
    return res.status(403).type('text/xml').send('<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error><RequestId>req-1</RequestId></ErrorResponse>');
  }
  if (action === 'AssumeRole') {
    return xml('<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIATEMPKEY1234567</AccessKeyId><SecretAccessKey>tempsecret0123456789</SecretAccessKey><SessionToken>temptoken</SessionToken><Expiration>2035-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>AROAX:aixp-dashboard</AssumedRoleId><Arn>arn:aws:sts::123456789012:assumed-role/aixp-reader/aixp-dashboard</Arn></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>req-2</RequestId></ResponseMetadata></AssumeRoleResponse>');
  }
  const arn = key.startsWith('ASIA') ? 'arn:aws:sts::123456789012:assumed-role/aixp-reader/aixp-dashboard' : 'arn:aws:iam::123456789012:user/aixp-reader';
  return xml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${arn}</Arn><UserId>AIDAX</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>req-3</RequestId></ResponseMetadata></GetCallerIdentityResponse>`);
}

function buildFake() {
  const app = express();
  app.use(express.text({ type: () => true, limit: '5mb' }));
  app.get('/logging/modelinvocations', (req, res) => {
    fake.bedrockCalls.push({ key: authKey(req) });
    res.json(fake.loggingConfig ? { loggingConfig: fake.loggingConfig } : {});
  });
  app.post('/', (req, res) => {
    const target = req.headers['x-amz-target'];
    if (!target) return stsOp(req.body, req, res);
    const [svc, op] = String(target).split('.');
    const body = req.body ? JSON.parse(req.body) : {};
    if (svc === 'Logs_20140328') return logsOp(op, body, req, res);
    if (svc === 'AWSInsightsIndexService') return ceOp(body, req, res);
    if (svc === 'GraniteServiceVersion20100801') return cwOp(op, body, req, res);
    return ERR_JSON(res, 400, 'UnknownOperationException', String(target));
  });
  return app;
}

// ---- helpers --------------------------------------------------------------------------------

let app;
let admin;
let baseId;
let baseCounts;
let P1;
let P2;
const put = (patch) => admin.call('PUT', '/api/settings', { patch });
const platformCounts = (id) => Object.fromEntries(db.prepare('SELECT platform, count(*) n FROM usage WHERE dataset_id = ? GROUP BY platform').all(id).map((r) => [r.platform, r.n]));

async function configure(extra) {
  const r = await put(Object.assign({
    'bedrock.enabled': true, 'bedrock.access_key_id': ACCESS_KEY, 'bedrock.secret_access_key': SECRET, 'bedrock.session_token': null,
    'bedrock.role_arn': '', 'bedrock.region': 'us-east-1', 'bedrock.log_group': GROUP, 'bedrock.identity_rule': 'session',
    'bedrock.cost_services': 'Amazon Bedrock', 'bedrock.history_floor': '',
    'bedrock.endpoint_logs': fake.base, 'bedrock.endpoint_ce': fake.base, 'bedrock.endpoint_cloudwatch': fake.base,
    'bedrock.endpoint_sts': fake.base, 'bedrock.endpoint_bedrock': fake.base, 'vendors.months_back': 2,
  }, extra || {}));
  assert.equal(r.status, 200, r.text);
}

function resetFake() {
  for (const k of ['logsCalls', 'ceCalls', 'cwCalls', 'stsCalls', 'bedrockCalls', 'creds']) fake[k].length = 0;
  fake.queryOutcome.clear(); fake.polls.clear();
  fake.throttleStart = 0; fake.denyLogs = false; fake.denyCe = false; fake.groups = [GROUP]; fake.pageSize = 4; fake.cePerPage = 3;
  fake.firstEvent = '2026-09-02 10:00:00.000';
  fake.loggingConfig = { cloudWatchConfig: { logGroupName: GROUP, roleArn: 'arn:aws:iam::123456789012:role/bedrock-logs' }, textDataDeliveryEnabled: true };
  bedrock.setRowCap(null);
  aws.resetStats();
}

test.before(async () => {
  seedFixture({ months: 3, people: 120, profile: 'clean', endDate: '2026-10-30', label: 'baseline fixture' });
  baseId = datasets.active().id;
  baseCounts = platformCounts(baseId);
  const ppl = db.prepare("SELECT person_key, email, user_id FROM people WHERE dataset_id = ? AND coalesce(email, '') <> '' AND coalesce(user_id, '') <> '' ORDER BY person_key LIMIT 2").all(baseId);
  P1 = { key: ppl[0].person_key, email: ppl[0].email.toLowerCase() };
  P2 = { key: ppl[1].person_key, login: String(ppl[1].user_id).toLowerCase() };
  fake.logEvents = genLogs(P1.email, P2.login);
  fake.ce = genCe();
  fake.metricModels = [CLAUDE, CLAUDE_X, NOVA];
  fake.server = buildFake().listen(0);
  await new Promise((r) => fake.server.once('listening', r));
  fake.base = `http://127.0.0.1:${fake.server.address().port}`;
  aws.setBackoff(1);
  bedrock.setPoll(0);
  time.setNow(NOW);
  app = await startApp();
  admin = await app.admin();
  app.call = admin.call;
});
test.after(async () => {
  time.setNow(null);
  aws.setBackoff(null);
  bedrock.setPoll(null);
  bedrock.setRowCap(null);
  if (app) await app.close();
  await new Promise((r) => fake.server.close(r));
  teardown(ctx);
});
test.beforeEach(() => resetFake());

// ---- pure functions -------------------------------------------------------------------------

test('modelKeyMatch: usage types and model ids, matches and non-matches', () => {
  const yes = [
    ['Claude4.6Sonnet', 'anthropic.claude-sonnet-4-6-20260301-v1:0'],
    ['Nova2.0Lite', 'amazon.nova-2-lite-v1:0'],
    ['USE1-Claude4.6Sonnet-input-tokens', 'us.anthropic.claude-sonnet-4-6-20260301-v1:0'],
    ['USE1-Claude4.6Sonnet-output-tokens-cross-region-global', 'global.anthropic.claude-sonnet-4-6-20260301-v1:0'],
    ['USE1-Nova2.0Lite-input-tokens-flex', 'apac.amazon.nova-2-lite-v1:0'],
    ['USE1-openai.gpt-oss-120b-mantle-input-tokens-standard', 'openai.gpt-oss-120b-1:0'],
    ['Claude3.5Sonnet', 'anthropic.claude-3-5-sonnet-20241022-v2:0'],
    ['Claude4.6Sonnet', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-20260301-v1:0'],
    ['USW2-Claude4.6Sonnet-cache-read-input-token-count', CLAUDE],
    ['Claude4.1Opus', 'anthropic.claude-opus-4-1-20250805-v1:0'],
  ];
  const no = [
    ['Claude4.6Sonnet', 'anthropic.claude-haiku-4-5-20251001-v1:0'],
    ['Claude4.6Sonnet', 'anthropic.claude-sonnet-4-5-20250929-v1:0'],
    ['Nova2.0Lite', 'amazon.nova-lite-v1:0'],
    ['Nova2.0Lite', 'amazon.nova-2-pro-v1:0'],
    ['USE1-Titan-Text-Express-input-tokens', CLAUDE],
    ['', CLAUDE],
    ['Claude4.6Sonnet', ''],
  ];
  for (const [a, b] of yes) assert.equal(bedrock.modelKeyMatch(a, b), true, `${a} <> ${b}`);
  for (const [a, b] of no) assert.equal(bedrock.modelKeyMatch(a, b), false, `${a} <> ${b}`);
  assert.ok(yes.length + no.length >= 8);
});

test('parseUsageType, normalizeModelId, whoOf and the masking helpers', () => {
  assert.deepEqual(bedrock.parseUsageType('USE1-Claude4.6Sonnet-input-tokens'), { region: 'USE1', model: 'Claude4.6Sonnet', tokenType: 'input-tokens' });
  assert.equal(bedrock.parseUsageType('USE1-openai.gpt-oss-120b-mantle-input-tokens-standard').model, 'openai.gpt-oss-120b');
  assert.equal(bedrock.parseUsageType('USE1-gpt-oss-120b-output-tokens-priority').model, 'gpt-oss-120b');
  assert.equal(bedrock.parseUsageType('USW2-Claude4.6Sonnet-output-tokens-cross-region-global').tokenType, 'output-tokens-cross-region-global');
  assert.equal(bedrock.normalizeModelId('arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-x-v1:0'), 'anthropic.claude-x-v1:0');
  assert.equal(bedrock.normalizeModelId(CLAUDE_X), CLAUDE);
  assert.equal(bedrock.normalizeModelId('eu.amazon.nova-2-lite-v1:0'), NOVA);
  assert.equal(bedrock.normalizeModelId(NOVA), NOVA);
  assert.deepEqual(bedrock.whoOf('arn:aws:sts::123456789012:assumed-role/DevRole/Jane.Doe@Corp.Example'), { role: 'devrole', who: 'jane.doe@corp.example' });
  assert.deepEqual(bedrock.whoOf('arn:aws:iam::123456789012:user/ops/Svc-Batch'), { role: '', who: 'svc-batch' });
  assert.deepEqual(bedrock.whoOf('arn:aws:iam::123456789012:root'), { role: '', who: 'root' });
  assert.deepEqual(bedrock.whoOf(''), { role: '', who: '' });
  assert.equal(bedrock.maskArn('arn:aws:sts::123456789012:assumed-role/R/s'), 'arn:aws:sts::********9012:assumed-role/R/s');
  assert.match(bedrock.shapeOf('jane.doe@corp.example'), /^aaaa\.aaa@aaaa\.aaaaaaa \(e-mail address\)$/);
  assert.match(bedrock.shapeOf('U2000001'), /^a9999999 \(other\)$/);
});

// ---- settings, registry ---------------------------------------------------------------------

test('settings: validators, endpoints, secrets encrypted and masked', async () => {
  assert.equal((await put({ 'bedrock.region': 'us-west-2' })).status, 200);
  assert.equal((await put({ 'bedrock.region': 'moon' })).status, 400);
  assert.equal((await put({ 'bedrock.region': '' })).status, 400);
  assert.equal((await put({ 'bedrock.region': 'us-east-1' })).status, 200);
  assert.equal((await put({ 'bedrock.access_key_id': 'has space' })).status, 400);
  assert.equal((await put({ 'bedrock.role_arn': 'not-an-arn' })).status, 400);
  assert.equal((await put({ 'bedrock.role_arn': 'arn:aws:iam::123456789012:role/aixp-reader' })).status, 200);
  assert.equal((await put({ 'bedrock.role_arn': '' })).status, 200);
  assert.equal((await put({ 'bedrock.identity_rule': 'guess' })).status, 400);
  assert.equal((await put({ 'bedrock.identity_rule': 'metadata' })).status, 200);
  assert.equal((await put({ 'bedrock.identity_rule': 'session' })).status, 200);
  assert.equal((await put({ 'bedrock.log_group': 'bad group name' })).status, 400);
  assert.equal((await put({ 'bedrock.log_group': GROUP })).status, 200);
  assert.equal((await put({ 'bedrock.rebuild_days': 0 })).status, 400);
  assert.equal((await put({ 'bedrock.rebuild_days': 32 })).status, 400);
  assert.equal((await put({ 'bedrock.rebuild_days': 3 })).status, 200);
  assert.equal((await put({ 'bedrock.history_floor': '2026-13-45' })).status, 400);
  assert.equal((await put({ 'bedrock.history_floor': '2026-09-02' })).status, 200);
  assert.equal((await put({ 'bedrock.history_floor': '' })).status, 200);
  assert.equal((await put({ 'bedrock.endpoint_logs': 'ftp://nope' })).status, 400);
  assert.equal((await put({ 'bedrock.endpoint_logs': 'https://proxy.example.com/' })).status, 200);
  assert.equal(settings.get('bedrock.endpoint_logs'), 'https://proxy.example.com');
  assert.equal((await put({ 'bedrock.endpoint_logs': '' })).status, 200);
  assert.equal((await put({ 'bedrock.cost_services': '  \n ' })).status, 400);
  assert.equal((await put({ 'bedrock.cost_services': 'Amazon Bedrock\r\nClaude Sonnet 4.6 (Amazon Bedrock Edition)' })).status, 200);
  assert.equal(settings.get('bedrock.cost_services'), 'Amazon Bedrock\nClaude Sonnet 4.6 (Amazon Bedrock Edition)');
  assert.equal((await put({ 'bedrock.cost_services': 'Amazon Bedrock' })).status, 200);
  for (const [k, v] of [['bedrock.secret_access_key', SECRET], ['bedrock.session_token', 'tok-0123456789']]) {
    const r = await put({ [k]: v });
    assert.deepEqual(r.json[k], { set: true });
    assert.ok(!r.text.includes(v));
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(k).value;
    assert.ok(stored.startsWith('"enc:v1:'), `${k} stored encrypted`);
    assert.equal(settings.getSecret(k), v);
    assert.equal((await put({ [k]: { set: true } })).status, 200);
    assert.equal(settings.getSecret(k), v, 'the masked object keeps the secret');
    await put({ [k]: null });
    assert.equal(settings.getSecret(k), '');
  }
  const d = (await admin.call('GET', '/api/settings')).json;
  assert.equal(d['bedrock.region'], 'us-east-1');
  assert.equal(d['bedrock.identity_rule'], 'session');
  assert.equal(d['bedrock.cost_services'], 'Amazon Bedrock');
  assert.equal(d['bedrock.enabled'], false);
});

test('registry, problems() and describe(): field shapes the generic card renders', async () => {
  await put({ 'bedrock.access_key_id': '', 'bedrock.secret_access_key': null });
  assert.deepEqual(bedrock.problems(), ['access key id', 'secret access key']);
  await put({ 'bedrock.access_key_id': ACCESS_KEY });
  assert.deepEqual(bedrock.problems(), ['secret access key']);
  await put({ 'bedrock.secret_access_key': SECRET });
  assert.deepEqual(bedrock.problems(), []);
  const d = bedrock.describe();
  const keys = d.fields.map((f) => f.key);
  assert.deepEqual(keys, [
    'bedrock.access_key_id', 'bedrock.secret_access_key', 'bedrock.session_token', 'bedrock.role_arn', 'bedrock.region', 'bedrock.log_group',
    'bedrock.identity_rule', 'bedrock.metadata_user_key', 'bedrock.cost_services', 'bedrock.rebuild_days', 'bedrock.history_floor',
    'bedrock.endpoint_logs', 'bedrock.endpoint_ce', 'bedrock.endpoint_cloudwatch', 'bedrock.endpoint_sts', 'bedrock.endpoint_bedrock',
  ]);
  assert.ok(d.fields.every((f) => f.key && f.label && f.type), 'key, label and type on every field');
  assert.deepEqual(d.fields.filter((f) => f.type === 'secret').map((f) => f.key), ['bedrock.secret_access_key', 'bedrock.session_token']);
  const sel = d.fields.find((f) => f.key === 'bedrock.identity_rule');
  assert.equal(sel.type, 'select');
  assert.deepEqual(sel.options.map((o) => o.value), ['session', 'metadata']);
  assert.ok(sel.options.every((o) => o.label));
  assert.equal(d.fields.find((f) => f.key === 'bedrock.cost_services').type, 'textarea');
  assert.equal(d.fields.find((f) => f.key === 'bedrock.endpoint_sts').advanced, true);
  assert.equal(d.window_align, null);
  assert.ok(Array.isArray(d.help) && d.help.length >= 3);
  assert.ok(JSON.stringify(d).split('').every((ch) => ch.charCodeAt(0) < 128), 'ASCII only');
  assert.equal(connectors.get('bedrock').id, 'bedrock');
  assert.equal(connectors.get('bedrock').platform, 'bedrock');
  assert.ok(connectors.list().some((c) => c.id === 'bedrock'));
  const help = await admin.call('GET', '/api/help/integrations/bedrock');
  assert.equal(help.status, 200);
  assert.equal(help.json.status, 'built');
});

// ---- test() ---------------------------------------------------------------------------------

test('test(): not configured fails the first step and makes no request', async () => {
  await put({ 'bedrock.access_key_id': '', 'bedrock.secret_access_key': null });
  const t = await bedrock.test();
  assert.equal(t.ok, false);
  assert.deepEqual(t.steps.map((s) => s.key), ['credentials', 'logging', 'log_group', 'query', 'costs', 'metrics']);
  assert.match(t.steps[0].detail, /Not configured: access key id, secret access key/);
  assert.ok(t.steps.slice(1).every((s) => s.ok === false && /Not checked/.test(s.detail)));
  assert.equal(fake.stsCalls.length + fake.logsCalls.length, 0);
});

test('test(): bogus credentials surface the real STS error, stop there and hide the secret', async () => {
  await configure({ 'bedrock.access_key_id': BAD_KEY, 'bedrock.secret_access_key': BAD_SECRET });
  const r = await app.call('POST', '/api/vendors/bedrock/test');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.steps[0].key, 'credentials');
  assert.equal(r.json.steps[0].ok, false);
  assert.match(r.json.steps[0].detail, /InvalidClientTokenId/);
  assert.match(r.json.steps[0].detail, /security token included in the request is invalid/);
  assert.ok(r.json.steps.slice(1).every((s) => s.ok === false && /Not checked/.test(s.detail)));
  assert.ok(!r.text.includes(BAD_SECRET) && !r.text.includes(SECRET));
  assert.equal(fake.logsCalls.length, 0);
});

test('test(): a good run reports caller (account masked), logging, first event, identity shape, costs and metrics', async () => {
  await configure();
  fake.metricModels = [CLAUDE, CLAUDE_X, NOVA];
  const t = await bedrock.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.deepEqual(t.steps.map((s) => s.key), ['credentials', 'logging', 'log_group', 'query', 'costs', 'metrics']);
  assert.match(t.steps[0].detail, /arn:aws:iam::\*{8}9012:user\/aixp-reader/);
  assert.ok(!t.steps[0].detail.includes('123456789012'));
  assert.match(t.steps[1].detail, /On, writing to CloudWatch group \/aws\/bedrock\/test/);
  assert.match(t.steps[2].detail, /first event in it is at 2026-09-02 10:00:00\.000/);
  assert.match(t.steps[3].detail, /rows for/);
  assert.ok(!JSON.stringify(t.steps).includes('123456789012'), 'account id never shown in full');
  assert.equal(JSON.stringify(t.steps).includes(P1.email), false, 'no session value in a detail');
  assert.match(t.steps[4].detail, /usage types? over/);
  assert.match(t.steps[5].detail, /3 ModelId values/);
  assert.ok(!JSON.stringify(t).includes(SECRET));
});

test('test(): the sample identity shape shows the character pattern of the session, not the value', async () => {
  await configure();
  // one day of yesterday's data so the one-day query returns rows
  const yest = new Date(Date.parse(NOW) - 86400000);
  // test() uses the real clock for "yesterday"; shape the fake rows for whatever that day is
  const realYesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const saved = fake.logEvents;
  fake.logEvents = [{ day: realYesterday, arn: `arn:aws:sts::123456789012:assumed-role/DevRole/${P1.email}`, who: 'x', model: CLAUDE, inp: 10, out: 5, req: 1 }];
  try {
    const t = await bedrock.test();
    assert.match(t.steps[3].detail, /1 rows for/);
    assert.match(t.steps[3].detail, /assumed-role\/DevRole\/<a+[.a0-9]*@a+\.a+ \(e-mail address\)>/);
    assert.ok(!t.steps[3].detail.includes(P1.email));
    assert.ok(yest instanceof Date);
  } finally { fake.logEvents = saved; }
});

test('test(): logging off, the wrong group, S3 only and a missing group each fail their own step', async () => {
  await configure();
  fake.loggingConfig = null;
  let t = await bedrock.test();
  assert.equal(t.steps[1].ok, false);
  assert.match(t.steps[1].detail, /logging is off/);
  fake.loggingConfig = { cloudWatchConfig: { logGroupName: '/other/group' } };
  t = await bedrock.test();
  assert.match(t.steps[1].detail, /writing to \/other\/group, but bedrock\.log_group is \/aws\/bedrock\/test/);
  fake.loggingConfig = { s3Config: { bucketName: 'my-bucket' } };
  t = await bedrock.test();
  assert.match(t.steps[1].detail, /only to S3 bucket my-bucket/);
  fake.loggingConfig = { cloudWatchConfig: { logGroupName: GROUP } };
  fake.groups = [];
  t = await bedrock.test();
  assert.equal(t.steps[2].ok, false);
  assert.match(t.steps[2].detail, /No log group named \/aws\/bedrock\/test/);
  assert.equal(t.steps[3].ok, false);
});

test('test(): a denied logs call names the AWS error; a blank log group skips the log steps', async () => {
  await configure();
  fake.denyLogs = true;
  let t = await bedrock.test();
  assert.equal(t.steps[2].ok, false);
  assert.match(t.steps[2].detail, /AccessDeniedException/);
  assert.match(t.steps[2].detail, /logs:StartQuery/);
  fake.denyLogs = false;
  await configure({ 'bedrock.log_group': '' });
  t = await bedrock.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.match(t.steps[2].detail, /blank, skipped/);
});

// ---- pull -----------------------------------------------------------------------------------

test('pull(): 7-day chunks, polling, continuation tokens, person keys, orgs and the logged window', async () => {
  await configure();
  const logs = [];
  const progress = [];
  const r = await bedrock.pull({ from: FROM, to: TO, log: (m) => logs.push(m), progress: (s, e) => progress.push([s, e]) });

  const starts = fake.logsCalls.filter((c) => c.op === 'StartQuery');
  assert.equal(starts.length, 5, '2026-10-01 to 2026-11-04T08:00 is five 7-day chunks');
  assert.equal(starts[0].body.startTime, Date.parse('2026-10-01T00:00:00Z') / 1000);
  assert.equal(starts[1].body.startTime, Date.parse('2026-10-08T00:00:00Z') / 1000);
  assert.equal(starts[0].body.endTime, Date.parse('2026-10-08T00:00:00Z') / 1000 - 1);
  assert.equal(starts[4].body.endTime, Date.parse(TO) / 1000 - 1);
  assert.ok(starts.every((c) => c.body.logGroupName === GROUP && /stats sum\(input\.inputTokenCount\)/.test(c.body.queryString) && /by bin\(1d\) as day, identity\.arn as arn, modelId as model \| limit 100000/.test(c.body.queryString)));
  assert.ok(fake.logsCalls.some((c) => c.op === 'GetQueryResults' && c.body.nextToken), 'follows the continuation token');
  assert.ok(fake.logsCalls.filter((c) => c.op === 'GetQueryResults').length > starts.length * 2, 'polls before Complete and pages after');
  assert.ok(fake.logsCalls.every((c) => c.key === ACCESS_KEY));

  // Cost Explorer: the service filter, the usage type grouping, every NextPageToken followed
  assert.ok(fake.ceCalls.length >= 7);
  assert.deepEqual(fake.ceCalls[0].body.Filter, { Dimensions: { Key: 'SERVICE', Values: ['Amazon Bedrock'] } });
  assert.deepEqual(fake.ceCalls[0].body.GroupBy, [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }]);
  assert.equal(fake.ceCalls[0].body.Granularity, 'DAILY');
  assert.deepEqual(fake.ceCalls[0].body.Metrics, ['UnblendedCost']);
  assert.equal(fake.ceCalls[0].body.TimePeriod.Start, FROM);
  assert.ok(fake.ceCalls.slice(1).some((c) => c.body.NextPageToken));

  // tokens: everything logged, merged across the cross-Region id
  const logged = sum(fake.logEvents, (e) => e.inp + e.out);
  assert.equal(sum(r.usage, (u) => u.Tokens), logged);
  assert.ok(r.usage.every((u) => u.Platform === 'bedrock' && u.ConsumptionUnit === 'tokens' && u.Credits === ''));
  assert.ok(r.usage.every((u) => !u.Model.startsWith('us.')), 'cross-Region prefix removed from Model');
  const p1 = r.usage.filter((u) => u.PersonKey === P1.email && u.Date === '2026-10-03' && u.Model === CLAUDE);
  assert.equal(p1.length, 1, 'us. and plain ids of one model are one row');
  assert.equal(p1[0].Tokens, (1000 + 2 + 200) + (500 + 100));
  assert.equal(p1[0].Email, P1.email);
  assert.equal(p1[0].Requests, 5);
  const p2 = r.usage.find((u) => u.PersonKey === P2.login && u.Date === '2026-10-02' && u.Model === NOVA);
  assert.ok(p2, 'a login-style session name is the key');
  assert.equal(p2.Email, '');
  assert.ok(r.usage.some((u) => u.PersonKey === 'svc-batch'), 'iam user name');
  const empty = r.usage.filter((u) => u.PersonKey === 'bedrock:unattributed' && u.Tokens > 0);
  assert.equal(empty.length, 1, 'a record with no identity lands on bedrock:unattributed');
  assert.equal(empty[0].Date, '2026-10-03');

  // dollars: allocation sums equal the CE dollars
  const ceTotal = sum(fake.ce, (c) => c.usd);
  assert.ok(Math.abs(sum(r.usage, (u) => Number(u.CostUSD) || 0) - ceTotal) < 1e-6, 'user and unattributed dollars add up to Cost Explorer');
  assert.ok(Math.abs(r.coverage.ce_total_usd - ceTotal) < 1e-6);
  assert.ok(Math.abs(r.coverage.allocated_usd + r.coverage.unattributed_usd - ceTotal) < 1e-6);
  assert.equal(r.coverage.log_rows, fake.logEvents.length);
  assert.equal(r.coverage.earliest_log_day, '2026-10-01');
  // Oct 2: nova dollars 1.3 split by token share between P2 (400) and svc-batch (1000)
  const novaRows = r.usage.filter((u) => u.Date === '2026-10-02' && u.Model === NOVA);
  assert.equal(novaRows.length, 2);
  assert.ok(Math.abs(novaRows.find((u) => u.PersonKey === P2.login).CostUSD - 1.3 * 400 / 1400) < 1e-9);
  assert.ok(novaRows.every((u) => u.CostSource === 'allocated'));
  // claude on Oct 2: input 2.01 + output 4.00
  const claude = r.usage.filter((u) => u.Date === '2026-10-02' && u.Model === CLAUDE);
  assert.ok(Math.abs(sum(claude, (u) => u.CostUSD) - 6.01) < 1e-9);
  // dollars with no log rows, and a usage type that matches no model
  const noLogs = r.usage.find((u) => u.Date === '2026-10-25');
  assert.equal(noLogs.PersonKey, 'bedrock:unattributed');
  assert.equal(noLogs.Model, 'Claude4.6Sonnet');
  assert.equal(noLogs.CostSource, 'vendor');
  assert.equal(noLogs.CostUSD, 1.5);
  assert.equal(noLogs.Tokens, 0);
  const titan = r.usage.find((u) => u.Date === '2026-10-05' && u.Model === 'Titan-Text-Express');
  assert.equal(titan.PersonKey, 'bedrock:unattributed');
  assert.equal(titan.CostUSD, 0.25);

  // every usage type is kept in the detail rows with its dollars and the model it mapped to
  const ut = r.detail.filter((d) => d.person_key === 'bedrock:usagetype');
  assert.equal(ut.length, fake.ce.length);
  assert.ok(Math.abs(sum(ut, (d) => d.cost_usd) - ceTotal) < 1e-6);
  assert.equal(ut.find((d) => d.date === '2026-10-02' && /Nova2\.0Lite-input/.test(d.product)).model, NOVA);
  assert.equal(ut.find((d) => /Titan/.test(d.product)).model, '');
  const rawKept = r.detail.filter((d) => d.person_key === P1.email && d.date === '2026-10-03');
  assert.deepEqual(rawKept.map((d) => d.product).sort(), [CLAUDE, CLAUDE_X].sort(), 'the raw modelId is kept in the detail rows');

  // the role name is the vendor org
  assert.equal(r.orgs.values.length, 1);
  assert.equal(r.orgs.values[0].value, 'devrole');
  const members = r.orgs.values[0].people.map((p) => p.person_key).sort();
  assert.deepEqual(members, [P1.email, P2.login].sort());
  assert.ok(logs.some((m) => /invocation logs: \d+ rows, earliest day 2026-10-01/.test(m)));
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});

test('pull(): a chunk that returns the row cap is re-run one day at a time and gives the same figures', async () => {
  await configure();
  const base = await bedrock.pull({ from: FROM, to: TO, log: () => {} });
  resetFake();
  bedrock.setRowCap(6); // a 7-day chunk holds 30+ rows, one day at most 5
  const logs = [];
  const r = await bedrock.pull({ from: FROM, to: TO, log: (m) => logs.push(m) });
  const starts = fake.logsCalls.filter((c) => c.op === 'StartQuery');
  assert.ok(starts.every((c) => /limit 6$/.test(c.body.queryString)));
  const dayRuns = starts.filter((c) => c.body.endTime - c.body.startTime === 86399);
  assert.ok(dayRuns.length >= 14, `per-day runs for the capped chunks (${dayRuns.length})`);
  assert.ok(logs.some((m) => /returned \d+ rows \(the query cap\); running it again one day at a time/.test(m)));
  assert.equal(sum(r.usage, (u) => u.Tokens), sum(base.usage, (u) => u.Tokens));
  assert.ok(Math.abs(sum(r.usage, (u) => Number(u.CostUSD) || 0) - sum(base.usage, (u) => Number(u.CostUSD) || 0)) < 1e-6);
  assert.equal(r.coverage.log_rows, fake.logEvents.length);
});

test('pull(): identity rule metadata groups by the request metadata value, lowercased, blank is unattributed', async () => {
  await configure({ 'bedrock.identity_rule': 'metadata', 'bedrock.metadata_user_key': 'user' });
  fake.logEvents = genLogs(P1.email, P2.login);
  const r = await bedrock.pull({ from: FROM, to: '2026-10-21T00:00:00.000Z', log: () => {} });
  const starts = fake.logsCalls.filter((c) => c.op === 'StartQuery');
  assert.ok(starts.every((c) => /requestMetadata\.user as who/.test(c.body.queryString) && !/identity\.arn/.test(c.body.queryString)));
  const keys = new Set(r.usage.map((u) => u.PersonKey));
  assert.ok(keys.has(P1.email) && keys.has(P2.login) && keys.has('svc-batch') && keys.has('bedrock:unattributed'));
  assert.deepEqual(r.orgs.values, [], 'no role, no org');
  assert.equal(bedrock.queryString('metadata', 'my-key').includes('requestMetadata.`my-key` as who'), true);
});

test('pull(): no log group uses CloudWatch metrics per model on bedrock:unattributed and still attaches dollars', async () => {
  await configure({ 'bedrock.log_group': '' });
  const logs = [];
  const r = await bedrock.pull({ from: '2026-10-01', to: '2026-10-04T00:00:00.000Z', log: (m) => logs.push(m) });
  assert.equal(fake.logsCalls.length, 0, 'no Logs call');
  const lm = fake.cwCalls.filter((c) => c.op === 'ListMetrics');
  assert.equal(lm.length, 2, 'ListMetrics pages with NextToken');
  assert.ok(lm.every((c) => c.body.Namespace === 'AWS/Bedrock' && c.body.MetricName === 'InputTokenCount'));
  const gm = fake.cwCalls.filter((c) => c.op === 'GetMetricData');
  assert.equal(gm.length, 1);
  assert.equal(gm[0].body.MetricDataQueries.length, 9);
  assert.ok(gm[0].body.MetricDataQueries.every((q) => q.MetricStat.Period === 86400 && q.MetricStat.Stat === 'Sum' && q.MetricStat.Metric.Namespace === 'AWS/Bedrock'));
  assert.deepEqual([...new Set(gm[0].body.MetricDataQueries.map((q) => q.MetricStat.Metric.MetricName))].sort(), ['InputTokenCount', 'Invocations', 'OutputTokenCount']);
  assert.ok(r.usage.every((u) => u.PersonKey === 'bedrock:unattributed'));
  assert.deepEqual([...new Set(r.usage.filter((u) => u.Tokens > 0).map((u) => u.Model))].sort(), [CLAUDE, NOVA].sort());
  // the two claude ids merge: ids index 1 and 2 -> (1000+200) + (2000+400) per day
  const c1 = r.usage.find((u) => u.Model === CLAUDE && u.Tokens > 0);
  assert.equal(c1.Tokens, 1200 + 2400);
  assert.equal(c1.Requests, 6);
  assert.ok(sum(r.usage, (u) => Number(u.CostUSD) || 0) > 0, 'dollars attach by the same model match');
  assert.ok(Math.abs(sum(r.usage, (u) => Number(u.CostUSD) || 0) - sum(fake.ce.filter((c) => c.day >= '2026-10-01' && c.day <= '2026-10-04'), (c) => c.usd)) < 1e-6);
  assert.ok(logs.some((m) => /without per-user data/.test(m)));
  assert.deepEqual(r.orgs.values, []);
});

test('retry: a ThrottlingException retries up to three times, then stops with the AWS name', async () => {
  await configure();
  fake.throttleStart = 2;
  const r = await bedrock.pull({ from: '2026-10-01', to: '2026-10-02T00:00:00.000Z', log: () => {} });
  assert.ok(r.usage.length > 0);
  assert.equal(aws.stats.retries, 2);
  resetFake();
  fake.throttleStart = 10;
  await assert.rejects(() => bedrock.pull({ from: '2026-10-01', to: '2026-10-02T00:00:00.000Z', log: () => {} }), (e) => {
    assert.match(e.message, /ThrottlingException: Rate exceeded/);
    assert.equal(e.status, 502);
    return true;
  });
  assert.equal(aws.stats.retries, aws.RETRIES);
  resetFake();
  fake.denyLogs = true; // AccessDenied is not retried
  await assert.rejects(() => bedrock.pull({ from: '2026-10-01', to: '2026-10-02T00:00:00.000Z', log: () => {} }), /AccessDeniedException/);
  assert.equal(aws.stats.retries, 0);
});

test('role_arn: the key assumes the role (session aixp-dashboard) and the temporary key makes the reads', async () => {
  await configure({ 'bedrock.role_arn': 'arn:aws:iam::123456789012:role/aixp-reader' });
  const t = await bedrock.test();
  assert.equal(t.ok, true, JSON.stringify(t.steps));
  assert.match(t.steps[0].detail, /assumed-role\/aixp-reader\/aixp-dashboard/);
  assert.match(t.steps[0].detail, /after assuming the configured role/);
  assert.ok(fake.stsCalls.some((c) => c.action === 'AssumeRole' && c.key === ACCESS_KEY));
  assert.ok(fake.logsCalls.length > 0 && fake.logsCalls.every((c) => c.key === 'ASIATEMPKEY1234567'));
  assert.ok(fake.ceCalls.every((c) => c.key === 'ASIATEMPKEY1234567'));
});

// ---- end to end -----------------------------------------------------------------------------

test('vendorImport: the bedrock pull lands as a dataset, resolves e-mail and login sessions to People, carries the other platforms over', async () => {
  await configure();
  assert.equal(datasets.active().id, baseId);
  const r = await app.call('POST', '/api/vendors/pull', { ids: ['bedrock'] });
  assert.equal(r.status, 200, r.text);
  const ds = datasets.active();
  assert.equal(ds.id, r.json.dataset_id);
  assert.deepEqual(ds.options.connectors, ['bedrock']);
  const counts = platformCounts(ds.id);
  for (const p of ['anthropic', 'github', 'openai', 'cowork']) assert.equal(counts[p], baseCounts[p], `${p} rows carried over`);
  assert.ok(counts.bedrock > 0);
  const keys = db.prepare("SELECT DISTINCT person_key FROM usage WHERE dataset_id = ? AND platform = 'bedrock'").all(ds.id).map((x) => x.person_key);
  assert.ok(keys.includes(P1.key), `e-mail session resolved to ${P1.key}: ${keys.join(',')}`);
  assert.ok(keys.includes(P2.key), `login session resolved to ${P2.key}`);
  assert.ok(keys.includes('svc-batch') && keys.includes('bedrock:unattributed'));
  assert.ok(!keys.includes(P1.email) && !keys.includes(P2.login));
  const matched = db.prepare("SELECT person_key, min(matched) m FROM usage WHERE dataset_id = ? AND platform = 'bedrock' GROUP BY person_key").all(ds.id);
  assert.equal(matched.find((x) => x.person_key === 'bedrock:unattributed').m, 0);
  const got = db.prepare("SELECT sum(cost_usd) c FROM usage WHERE dataset_id = ? AND platform = 'bedrock'").get(ds.id).c;
  const expect = sum(fake.ce.filter((c) => c.day >= '2026-09-01'), (c) => c.usd);
  assert.ok(Math.abs(got - expect) < 1e-6, `${got} vs ${expect}`);
  const det = db.prepare("SELECT count(*) n FROM vendor_usage_detail WHERE vendor = 'bedrock'").get().n;
  assert.ok(det > fake.ce.length);
  const org = db.prepare("SELECT value FROM vendor_org_values WHERE vendor = 'bedrock'").all().map((x) => x.value);
  assert.deepEqual(org, ['devrole']);
});

test('vendorImport: a failing AWS call fails the pull cleanly with the AWS error, never a 500', async () => {
  await configure();
  const before = datasets.active().id;
  fake.denyLogs = true;
  const r = await app.call('POST', '/api/vendors/pull', { ids: ['bedrock'] });
  assert.ok(r.status === 502 || (r.status >= 400 && r.status < 500), `status ${r.status}: ${r.text}`);
  assert.notEqual(r.status, 500);
  assert.match(r.text, /AccessDeniedException/);
  assert.equal(datasets.active().id, before, 'the active dataset is untouched');
  const lp = settings.get('vendors.last_pull');
  assert.ok(lp && lp.error, 'last_pull.error is set');
  assert.ok(!r.text.includes(SECRET) && !JSON.stringify(lp).includes(SECRET));
  const failed = db.prepare("SELECT status FROM datasets ORDER BY id DESC LIMIT 1").get();
  assert.ok(failed && /fail/i.test(String(failed.status)), `latest dataset status ${failed && failed.status}`);
});
