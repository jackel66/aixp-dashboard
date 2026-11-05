'use strict';
// AWS Bedrock connector (CONTRACT section 19.3). Built blind: no AWS account was available when this was
// written, so every UNVERIFIED shape is read defensively and the Test connection checklist is the fix loop.
//  - Tokens per user, model and day: CloudWatch Logs Insights over the model invocation log group
//    (identity.arn, modelId, input/output token counts). Logs exist only from the day logging was switched on.
//  - Without a log group: CloudWatch AWS/Bedrock metrics per ModelId (no user), rows on 'bedrock:unattributed'.
//  - Dollars: Cost Explorer per usage type per day, matched to models by modelKeyMatch and allocated across
//    that day's users by token share (cost_source 'allocated'); unmatched dollars land on 'bedrock:unattributed'.
const { StartQueryCommand, GetQueryResultsCommand, StopQueryCommand, DescribeLogGroupsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { ListMetricsCommand, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { GetModelInvocationLoggingConfigurationCommand } = require('@aws-sdk/client-bedrock');
const settings = require('../settings');
const aws = require('./awsClient');
const win = require('./window');
const { badRequest, upstream } = require('../../errors');

const id = 'bedrock';
const label = 'AWS Bedrock';
const platform = 'bedrock';
const HARD_FLOOR = '2020-01-01'; // no documented depth; Cost Explorer keeps 14 months, months_back decides
const UNATTRIBUTED = 'bedrock:unattributed';
const USAGETYPE_KEY = 'bedrock:usagetype'; // detail-only rows, one per Cost Explorer usage type
const CHUNK_DAYS = 7;
const CE_PAGES = 50;
const METRIC_BATCH = 99; // queries per GetMetricData call (33 models x 3 metrics)

let rowCap = 100000;
let pollMs = 1000;
let queryTimeoutMs = 90000;
// Tests shrink these so the cap branch and the poll loop run fast.
function setRowCap(n) { rowCap = n === undefined || n === null ? 100000 : n; }
function setPoll(ms) { pollMs = ms === undefined || ms === null ? 1000 : ms; }
function setQueryTimeout(ms) { queryTimeoutMs = ms === undefined || ms === null ? 90000 : ms; }
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const str = (k, d) => {
  const v = settings.get(k, d);
  return v === null || v === undefined ? '' : String(v).trim();
};
const enabled = () => !!settings.get('bedrock.enabled', false);
const rebuildDays = () => Number(settings.get('bedrock.rebuild_days', 3)) || 3;
const historyFloor = () => str('bedrock.history_floor', '') || HARD_FLOOR;
const logGroup = () => str('bedrock.log_group', '');
const identityRule = () => (str('bedrock.identity_rule', 'session') === 'metadata' ? 'metadata' : 'session');
const metadataKey = () => str('bedrock.metadata_user_key', 'user') || 'user';
const costServices = () => {
  const l = str('bedrock.cost_services', 'Amazon Bedrock').split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean);
  return l.length ? l : ['Amazon Bedrock'];
};

function problems() {
  const out = [];
  if (!str('bedrock.access_key_id', '')) out.push('access key id');
  if (!settings.getSecret('bedrock.secret_access_key')) out.push('secret access key');
  return out;
}

function describe() {
  return {
    fields: [
      { key: 'bedrock.access_key_id', label: 'Access key id', type: 'text', required: true, placeholder: 'AKIA...', hint: 'Access key of a read-only IAM user, or of the user that may assume the role below' },
      { key: 'bedrock.secret_access_key', label: 'Secret access key', type: 'secret', required: true },
      { key: 'bedrock.session_token', label: 'Session token', type: 'secret', hint: 'Only for pasted temporary keys (they expire); leave blank for an IAM user key' },
      { key: 'bedrock.role_arn', label: 'Role to assume', type: 'text', placeholder: 'arn:aws:iam::123456789012:role/aixp-reader', hint: 'Optional. When set, the key above calls sts:AssumeRole (session aixp-dashboard) and the role does the reading' },
      { key: 'bedrock.region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1', hint: 'The Region of the invocation log group and the Bedrock metrics. Cost Explorer always uses us-east-1' },
      { key: 'bedrock.log_group', label: 'Invocation log group', type: 'text', placeholder: '/aws/bedrock/modelinvocations', hint: 'The CloudWatch Logs group that Bedrock model invocation logging writes to. Blank gives no per-user data: per-model metrics are used instead' },
      {
        key: 'bedrock.identity_rule', label: 'Who is the user', type: 'select',
        options: [
          { value: 'session', label: 'The session name in the caller ARN (identity.arn)' },
          { value: 'metadata', label: 'A request metadata value set by the calling application' },
        ],
      },
      { key: 'bedrock.metadata_user_key', label: 'Request metadata key', type: 'text', advanced: true, hint: 'Used when "Who is the user" is request metadata. Applications set it as requestMetadata.<key>' },
      { key: 'bedrock.cost_services', label: 'Cost Explorer services', type: 'textarea', advanced: true, hint: 'One Cost Explorer SERVICE name per line. Marketplace-billed models may sit under other service lines than "Amazon Bedrock"' },
      { key: 'bedrock.rebuild_days', label: 'Re-pull days', type: 'number', min: 1, max: 31, advanced: true },
      { key: 'bedrock.history_floor', label: 'Logging started on', type: 'text', advanced: true, placeholder: 'YYYY-MM-DD', hint: 'The day invocation logging was switched on. Blank lets "months back" decide; Test connection shows the first event in the log group' },
      { key: 'bedrock.endpoint_logs', label: 'CloudWatch Logs endpoint', type: 'text', advanced: true, hint: 'Blank = AWS. Only for tests and proxies' },
      { key: 'bedrock.endpoint_ce', label: 'Cost Explorer endpoint', type: 'text', advanced: true, hint: 'Blank = AWS' },
      { key: 'bedrock.endpoint_cloudwatch', label: 'CloudWatch endpoint', type: 'text', advanced: true, hint: 'Blank = AWS' },
      { key: 'bedrock.endpoint_sts', label: 'STS endpoint', type: 'text', advanced: true, hint: 'Blank = AWS' },
      { key: 'bedrock.endpoint_bedrock', label: 'Bedrock endpoint', type: 'text', advanced: true, hint: 'Blank = AWS' },
    ],
    limits: {
      logs_start_query_per_second: 10, logs_rows_per_query: rowCap, logs_query_chunk_days: CHUNK_DAYS, logs_query_seconds: Math.round(queryTimeoutMs / 1000),
      cost_explorer_history_months: 14,
    },
    lag: 'Logs arrive within minutes; Cost Explorer figures can take 24 hours and are pulled again for rebuild_days days.',
    history_floor: historyFloor(),
    window_align: null,
    help: [
      'Create an IAM user (or a role) with read-only access to the log group, Cost Explorer, CloudWatch metrics and STS; the permission list is on the Help page. Paste the access key here, or add a role ARN to assume.',
      'Per-user tokens exist only in the model invocation logs, and only from the day logging was switched on. Turn logging on in the Bedrock console (Settings > Model invocation logging) with CloudWatch Logs as the destination, then enter the log group name.',
      'Dollars are not available per user in AWS. They come from Cost Explorer per usage type and day and are spread over that day\'s users by token share, so they are an allocation, not a billed amount.',
      'Calls through the bedrock-mantle endpoints (Responses and Chat Completions) are not written to invocation logs and are missing from the per-user figures.',
    ],
  };
}

// ---- model matching -------------------------------------------------------------------------

const TOKEN_WORDS = new Set(['input', 'output', 'cache', 'tokens', 'token', 'count', 'standard', 'priority', 'flex', 'cross', 'region', 'global', 'mantle']);
const REGION_PREFIX = /^[A-Z]{2,4}\d{1,2}$/;
const FAMILY_WORDS = ['claude', 'sonnet', 'haiku', 'opus', 'nova', 'llama', 'titan', 'mistral', 'mixtral', 'command', 'gptoss', 'deepseek', 'micro', 'lite', 'pro', 'premier', 'plus', 'light', 'large', 'small'];
const VENDOR_PREFIX = /^(anthropic|amazon|meta|mistral|cohere|openai)\./;
const CROSS_REGION_PREFIX = /^(us-gov|us|eu|apac|global)\./;

/** Cost Explorer usage type -> {region, model, tokenType}. USE1-Claude4.6Sonnet-input-tokens -> USE1 / Claude4.6Sonnet. */
function parseUsageType(usageType) {
  const segs = String(usageType === null || usageType === undefined ? '' : usageType).trim().split('-');
  let region = '';
  if (segs.length > 1 && REGION_PREFIX.test(segs[0])) region = segs.shift();
  const model = [];
  let i = 0;
  for (; i < segs.length; i++) {
    if (TOKEN_WORDS.has(segs[i].toLowerCase())) break;
    model.push(segs[i]);
  }
  return { region, model: model.join('-'), tokenType: segs.slice(i).join('-') };
}

/** Last path segment of a model id or ARN, cross-Region prefix removed (us., eu., apac., global.). Vendor prefix stays. */
function normalizeModelId(modelId) {
  let m = String(modelId === null || modelId === undefined ? '' : modelId).trim();
  if (!m) return '';
  m = m.split('/').pop();
  const lower = m.toLowerCase();
  const x = CROSS_REGION_PREFIX.exec(lower);
  if (x && lower.slice(x[0].length).includes('.')) m = m.slice(x[0].length);
  return m;
}

// Family words as a set and the version digits as a list, both from a usage-type model segment or a model id.
function modelFeatures(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim().split('/').pop().split(':')[0].toLowerCase();
  s = s.replace(CROSS_REGION_PREFIX, '').replace(VENDOR_PREFIX, '');
  s = s.replace(/-v\d+$/, '');
  s = s.replace(/(^|[^0-9])\d{8}(?![0-9])/g, '$1'); // date stamp such as -20260301
  s = s.replace(/([a-z])-\d$/, '$1'); // bare version after a size, openai.gpt-oss-120b-1
  const squash = s.replace(/[^a-z]/g, '');
  const words = FAMILY_WORDS.filter((w) => squash.includes(w));
  const digits = (s.match(/\d+/g) || []).map((d) => String(Number(d)));
  while (digits.length > 1 && digits[digits.length - 1] === '0') digits.pop(); // 2.0 reads as 2
  return { words, digits: digits.join('.') };
}

/**
 * True when a Cost Explorer usage type (or its model segment) and a Bedrock model id are the same model:
 * the family words agree as a set and the version digits agree after punctuation is removed.
 * Claude4.6Sonnet matches anthropic.claude-sonnet-4-6-20260301-v1:0; Nova2.0Lite matches amazon.nova-2-lite-v1:0.
 */
function modelKeyMatch(usageType, modelId) {
  const raw = String(usageType === null || usageType === undefined ? '' : usageType).trim();
  const p = parseUsageType(raw);
  const seg = p.region ? p.model : raw;
  const a = modelFeatures(seg);
  const b = modelFeatures(modelId);
  if (!a.words.length || a.words.length !== b.words.length) return false;
  if (!a.words.every((w) => b.words.includes(w))) return false;
  return a.digits === b.digits;
}

// ---- identity -------------------------------------------------------------------------------

/** identity.arn -> {role, who}. Lowercased and trimmed; who is '' when nothing usable is in the ARN. */
function whoOf(arn) {
  const a = String(arn === null || arn === undefined ? '' : arn).trim();
  if (!a) return { role: '', who: '' };
  let m = /^arn:[^:]*:sts::[^:]*:assumed-role\/([^/]+)\/(.+)$/.exec(a);
  if (m) return { role: m[1].toLowerCase(), who: m[2].trim().toLowerCase() };
  m = /^arn:[^:]*:iam::[^:]*:user\/(?:.*\/)?([^/]+)$/.exec(a);
  if (m) return { role: '', who: m[1].trim().toLowerCase() };
  const last = a.split(/[/:]/).filter(Boolean).pop() || '';
  return { role: '', who: last.trim().toLowerCase() };
}

// ---- Logs Insights --------------------------------------------------------------------------

function queryString(rule, key) {
  const group = rule === 'metadata'
    ? `requestMetadata.${/^[A-Za-z0-9_]+$/.test(key) ? key : '`' + key + '`'} as who`
    : 'identity.arn as arn';
  return 'fields @timestamp | stats sum(input.inputTokenCount) as input_tokens, '
    + 'sum(output.outputTokenCount) as output_tokens, count(*) as requests '
    + `by bin(1d) as day, ${group}, modelId as model | limit ${rowCap}`;
}

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function fieldsOf(row) {
  const o = {};
  for (const f of row || []) if (f && f.field && f.field !== '@ptr') o[f.field] = f.value;
  return o;
}

async function runQuery(c, group, qs, startMs, endMs) {
  const started = await aws.send(c.logs, new StartQueryCommand({
    logGroupName: group, startTime: Math.floor(startMs / 1000), endTime: Math.max(Math.floor(startMs / 1000), Math.floor(endMs / 1000) - 1), queryString: qs,
  }));
  const queryId = started && started.queryId;
  if (!queryId) throw badRequest('CloudWatch Logs did not return a query id');
  const t0 = Date.now();
  let resp;
  for (;;) {
    resp = await aws.send(c.logs, new GetQueryResultsCommand({ queryId }));
    const st = String(resp.status || '');
    if (st === 'Complete') break;
    if (st === 'Failed' || st === 'Cancelled' || st === 'Timeout' || st === 'Unknown') throw aws2(`Logs Insights query ${st}`);
    if (Date.now() - t0 > queryTimeoutMs) {
      try { await aws.send(c.logs, new StopQueryCommand({ queryId })); } catch (e) { /* best effort */ }
      throw aws2(`Logs Insights query did not finish in ${Math.round(queryTimeoutMs / 1000)} seconds`);
    }
    await sleep(pollMs);
  }
  const rows = (resp.results || []).slice();
  let token = resp.nextToken;
  let guard = 0;
  while (token && guard++ < 200) {
    const more = await aws.send(c.logs, new GetQueryResultsCommand({ queryId, nextToken: token }));
    rows.push(...(more.results || []));
    token = more.nextToken && more.nextToken !== token ? more.nextToken : null;
  }
  return rows;
}

const aws2 = (message) => upstream(message);

/** Chunks of at most 7 days covering [from 00:00Z, endIso). */
function chunks(from, endIso) { return win.slices(from, endIso, CHUNK_DAYS); }

async function logRows(c, group, from, to, log, progress) {
  const rule = identityRule();
  const qs = queryString(rule, metadataKey());
  const out = [];
  const reruns = [];
  for (const ch of chunks(from, to)) {
    const tag = `${win.toDate(ch.startMs)} to ${win.toDate(ch.endMs - 1)}`;
    let rows = await runQuery(c, group, qs, ch.startMs, ch.endMs);
    progress('usage', { table: 'invocation logs', chunk: tag, rows: out.length + rows.length, message: `invocation logs ${tag}: ${rows.length} rows` });
    if (rows.length >= rowCap) {
      log(`logs ${tag} returned ${rows.length} rows (the query cap); running it again one day at a time`);
      reruns.push(tag);
      rows = [];
      for (let d = ch.startMs; d < ch.endMs; d += win.DAY) {
        const dayEnd = Math.min(ch.endMs, d + win.DAY);
        const dayRows = await runQuery(c, group, qs, d, dayEnd);
        if (dayRows.length >= rowCap) log(`logs ${win.toDate(d)} still returned ${dayRows.length} rows (the query cap); some rows are missing`);
        rows.push(...dayRows);
      }
      progress('usage', { table: 'invocation logs', chunk: tag, rows: out.length + rows.length, message: `invocation logs ${tag} per day: ${rows.length} rows` });
    }
    out.push(...rows);
  }
  return { rows: out, rule, reruns };
}

// ---- grain rows -----------------------------------------------------------------------------

function newGrain() { return { map: new Map(), roles: new Map(), earliest: null, logRows: 0 }; }

function addGrain(g, day, key, email, model, raw, tokens, req) {
  const k = `${day}|${key}|${model}`;
  let r = g.map.get(k);
  if (!r) {
    r = { day, key, email: email || '', model, tokens: 0, req: 0, reqSeen: false, usd: 0, costed: false, raws: new Map() };
    g.map.set(k, r);
  }
  r.tokens += tokens;
  if (req !== null) { r.req += req; r.reqSeen = true; }
  if (!r.email && email) r.email = email;
  const w = r.raws.get(raw) || { tokens: 0, req: 0, reqSeen: false };
  w.tokens += tokens;
  if (req !== null) { w.req += req; w.reqSeen = true; }
  r.raws.set(raw, w);
}

function fromLogs(g, rows, rule) {
  for (const row of rows) {
    const f = fieldsOf(row);
    const day = String(f.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const rawModel = String(f.model || '').trim();
    if (!rawModel) continue;
    let who;
    let role = '';
    if (rule === 'metadata') who = String(f.who === undefined || f.who === null ? '' : f.who).trim().toLowerCase();
    else { const w = whoOf(f.arn); who = w.who; role = w.role; }
    const tokens = (num(f.input_tokens) || 0) + (num(f.output_tokens) || 0);
    const req = num(f.requests);
    g.logRows += 1;
    if (!g.earliest || day < g.earliest) g.earliest = day;
    const key = who || UNATTRIBUTED;
    const email = who.includes('@') ? who : '';
    if (role && key !== UNATTRIBUTED) {
      if (!g.roles.has(role)) g.roles.set(role, new Map());
      g.roles.get(role).set(key, { person_key: key, email, display_name: key });
    }
    addGrain(g, day, key, email, normalizeModelId(rawModel), rawModel, tokens, req);
  }
}

// ---- metrics fallback -----------------------------------------------------------------------

async function listModelIds(c) {
  const ids = new Set();
  let token;
  let pages = 0;
  do {
    const r = await aws.send(c.cloudwatch, new ListMetricsCommand({ Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', NextToken: token }));
    for (const m of r.Metrics || []) {
      const d = (m.Dimensions || []).find((x) => x.Name === 'ModelId');
      if (d && d.Value) ids.add(d.Value);
    }
    token = r.NextToken;
    pages += 1;
  } while (token && pages < 50);
  return [...ids].sort();
}

async function metricRows(c, g, from, to, log, progress) {
  const models = await listModelIds(c);
  progress('usage', { table: 'metrics', rows: 0, message: `${models.length} Bedrock models in CloudWatch metrics` });
  const NAMES = [['in', 'InputTokenCount'], ['out', 'OutputTokenCount'], ['req', 'Invocations']];
  const start = new Date(win.toMs(from));
  const end = new Date(Date.parse(to));
  const per = Math.max(1, Math.floor(METRIC_BATCH / NAMES.length));
  for (let i = 0; i < models.length; i += per) {
    const batch = models.slice(i, i + per);
    const queries = [];
    batch.forEach((m, bi) => {
      NAMES.forEach(([k, name]) => queries.push({
        Id: `m${bi}_${k}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: name, Dimensions: [{ Name: 'ModelId', Value: m }] }, Period: 86400, Stat: 'Sum' },
      }));
    });
    const series = new Map(); // Id -> Map(day -> value)
    let token;
    let pages = 0;
    do {
      const r = await aws.send(c.cloudwatch, new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end, ScanBy: 'TimestampAscending', NextToken: token }));
      for (const res of r.MetricDataResults || []) {
        const mp = series.get(res.Id) || new Map();
        (res.Timestamps || []).forEach((t, ti) => {
          const day = new Date(t).toISOString().slice(0, 10);
          mp.set(day, (mp.get(day) || 0) + (num((res.Values || [])[ti]) || 0));
        });
        series.set(res.Id, mp);
      }
      token = r.NextToken;
      pages += 1;
    } while (token && pages < 50);
    batch.forEach((m, bi) => {
      const inn = series.get(`m${bi}_in`) || new Map();
      const out = series.get(`m${bi}_out`) || new Map();
      const req = series.get(`m${bi}_req`) || new Map();
      const days = new Set([...inn.keys(), ...out.keys(), ...req.keys()]);
      for (const day of days) {
        const tokens = (inn.get(day) || 0) + (out.get(day) || 0);
        if (tokens === 0 && !req.get(day)) continue;
        addGrain(g, day, UNATTRIBUTED, '', normalizeModelId(m), m, tokens, req.has(day) ? req.get(day) : null);
      }
    });
    progress('usage', { table: 'metrics', rows: g.map.size, message: `metrics for ${Math.min(models.length, i + per)} of ${models.length} models` });
  }
  if (!models.length) log('CloudWatch has no AWS/Bedrock InputTokenCount metrics in this Region');
}

// ---- Cost Explorer --------------------------------------------------------------------------

async function costRows(c, from, to, services) {
  const endDay = win.addDays(String(to).slice(0, 10), 1);
  const out = new Map(); // day|usageType -> usd
  let token;
  let pages = 0;
  do {
    const r = await aws.send(c.ce, new GetCostAndUsageCommand({
      TimePeriod: { Start: from, End: endDay }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
      Filter: { Dimensions: { Key: 'SERVICE', Values: services } },
      GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      NextPageToken: token,
    }));
    for (const t of r.ResultsByTime || []) {
      const day = String((t.TimePeriod || {}).Start || '').slice(0, 10);
      for (const gr of t.Groups || []) {
        const ut = (gr.Keys || [])[0];
        const m = (gr.Metrics || {}).UnblendedCost || {};
        const usd = num(m.Amount);
        if (!day || !ut || usd === null) continue;
        if (m.Unit && String(m.Unit).toUpperCase() !== 'USD') continue;
        const k = `${day}|${ut}`;
        out.set(k, (out.get(k) || 0) + usd);
      }
    }
    token = r.NextPageToken;
    pages += 1;
  } while (token && pages < CE_PAGES);
  return [...out.entries()].map(([k, usd]) => {
    const i = k.indexOf('|');
    return { day: k.slice(0, i), ut: k.slice(i + 1), usd };
  });
}

/** Spread every usage type's dollars over that day's matching rows by token share; the rest is unattributed. */
function allocate(g, ceRows) {
  const byDay = new Map();
  for (const r of g.map.values()) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const unattr = new Map(); // day|seg -> {day, seg, usd}
  const typeRows = [];
  let total = 0;
  const sorted = ceRows.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.ut < b.ut ? -1 : a.ut > b.ut ? 1 : 0));
  for (const ce of sorted) {
    total += ce.usd;
    const seg = parseUsageType(ce.ut).model;
    const matched = (byDay.get(ce.day) || []).filter((r) => modelKeyMatch(ce.ut, r.model));
    typeRows.push({ day: ce.day, ut: ce.ut, usd: ce.usd, model: matched.length ? matched[0].model : '' });
    if (!matched.length) {
      const k = `${ce.day}|${seg}`;
      const u = unattr.get(k) || { day: ce.day, seg: seg || 'unattributed', usd: 0 };
      u.usd += ce.usd;
      unattr.set(k, u);
      continue;
    }
    const tokTotal = matched.reduce((a, r) => a + r.tokens, 0);
    let left = ce.usd;
    matched.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    matched.forEach((r, i) => {
      const share = i === matched.length - 1 ? left : ce.usd * (tokTotal > 0 ? r.tokens / tokTotal : 1 / matched.length);
      left -= share;
      r.usd += share;
      r.costed = true;
    });
  }
  return { total, unattr: [...unattr.values()], typeRows };
}

// ---- assemble -------------------------------------------------------------------------------

function build(g, alloc) {
  const usage = [];
  const detail = [];
  let attributedUsd = 0;
  let unattributedUsd = 0;
  const rows = [...g.map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  for (const r of rows) {
    usage.push({
      Date: r.day, PersonKey: r.key, Platform: platform, Model: r.model, Tokens: r.tokens, Credits: '', ConsumptionUnit: 'tokens',
      CostUSD: r.costed ? r.usd : '', Requests: r.reqSeen ? r.req : '', CostSource: r.costed ? 'allocated' : '', Email: r.email,
    });
    if (r.costed) { if (r.key === UNATTRIBUTED) unattributedUsd += r.usd; else attributedUsd += r.usd; }
    for (const [raw, w] of r.raws) {
      detail.push({
        vendor: id, date: r.day, person_key: r.key, email: r.email, model: r.model, product: raw, tokens: w.tokens,
        cost_usd: r.costed && r.tokens > 0 ? r.usd * (w.tokens / r.tokens) : (r.costed && r.raws.size === 1 ? r.usd : 0),
        list_cost_usd: null, requests: w.reqSeen ? w.req : null,
      });
    }
  }
  for (const u of alloc.unattr) {
    usage.push({
      Date: u.day, PersonKey: UNATTRIBUTED, Platform: platform, Model: u.seg, Tokens: 0, Credits: '', ConsumptionUnit: 'tokens',
      CostUSD: u.usd, Requests: '', CostSource: 'vendor', Email: '',
    });
    unattributedUsd += u.usd;
  }
  for (const t of alloc.typeRows) {
    detail.push({
      vendor: id, date: t.day, person_key: USAGETYPE_KEY, email: '', model: t.model, product: `usage_type:${t.ut}`, tokens: 0,
      cost_usd: t.usd, list_cost_usd: null, requests: null,
    });
  }
  usage.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : a.PersonKey < b.PersonKey ? -1 : a.PersonKey > b.PersonKey ? 1 : a.Model < b.Model ? -1 : a.Model > b.Model ? 1 : 0));
  return { usage, detail, attributedUsd, unattributedUsd };
}

// ---- pull -----------------------------------------------------------------------------------

async function pull({ from, to, log = () => {}, progress = () => {} }) {
  const miss = problems();
  if (miss.length) throw badRequest(`AWS Bedrock is not configured: ${miss.join(', ')}`);
  progress('auth', { message: 'Reading from AWS' });
  const c = aws.build();
  const g = newGrain();
  const group = logGroup();
  let reruns = [];
  if (group) {
    const r = await logRows(c, group, from, to, log, progress);
    fromLogs(g, r.rows, r.rule);
    reruns = r.reruns;
    log(`invocation logs: ${g.logRows} rows${g.earliest ? `, earliest day ${g.earliest}` : ''}${reruns.length ? `, re-run per day: ${reruns.join(', ')}` : ''}`);
    if (!g.logRows) log('the log group returned no rows; logging may have been switched on after this window');
  } else {
    log('bedrock.log_group is blank: this pull runs without per-user data, tokens come from CloudWatch metrics per model');
    await metricRows(c, g, from, to, log, progress);
  }
  progress('usage', { table: 'costs', rows: 0, message: 'Reading Cost Explorer' });
  const ce = await costRows(c, from, to, costServices());
  progress('usage', { table: 'costs', rows: ce.length, message: `Cost Explorer: ${ce.length} usage type days` });
  const alloc = allocate(g, ce);
  const b = build(g, alloc);
  const values = [...g.roles.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([value, people]) => ({ value, people: [...people.values()] }));
  const ceTotal = alloc.total;
  return {
    usage: b.usage,
    detail: b.detail,
    orgs: { values },
    coverage: {
      ce_total_usd: ceTotal, allocated_usd: b.attributedUsd, unattributed_usd: b.unattributedUsd, log_rows: g.logRows, earliest_log_day: g.earliest,
      org_total_usd: ceTotal, user_rows_usd: b.attributedUsd, data_refreshed_at: null,
    },
  };
}

// ---- test -----------------------------------------------------------------------------------

// arn:aws:sts::123456789012:assumed-role/Role/jane -> account masked to its last four digits.
function maskArn(arn) {
  const p = String(arn || '').split(':');
  if (p.length > 4 && /^\d{12}$/.test(p[4])) p[4] = `********${p[4].slice(8)}`;
  return p.join(':');
}

// A session or user name reduced to its character shape: letters -> a, digits -> 9, the rest kept.
function shapeOf(value) {
  const v = String(value === null || value === undefined ? '' : value);
  const s = v.replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9').slice(0, 40);
  const kind = v.includes('@') ? 'e-mail address' : /^\d+$/.test(v) ? 'numeric id' : /^[A-Za-z]+[._-][A-Za-z]+$/.test(v) ? 'first.last style name' : 'other';
  return `${s} (${kind})`;
}

function sampleShape(rule, f) {
  if (rule === 'metadata') return `request metadata value shaped ${shapeOf(f.who)}`;
  const arn = String(f.arn || '');
  const p = maskArn(arn);
  const m = /^(.*assumed-role\/[^/]+\/)(.+)$/.exec(p);
  if (m) return `${m[1]}<${shapeOf(m[2])}>`;
  const u = /^(.*:user\/(?:.*\/)?)([^/]+)$/.exec(p);
  if (u) return `${u[1]}<${shapeOf(u[2])}>`;
  return p ? `${p.split(':').slice(0, 5).join(':')}:<${shapeOf(p.split(/[/:]/).pop())}>` : '(empty identity.arn)';
}

async function test() {
  const t0 = Date.now();
  const steps = [];
  const add = (key, ok, lbl, detail) => { steps.push({ key, ok, label: lbl, detail }); return ok; };
  const finish = () => ({ ok: steps.every((s) => s.ok), duration_ms: Date.now() - t0, steps });
  const ALL = [['credentials', 'AWS credentials'], ['logging', 'Invocation logging'], ['log_group', 'Log group'], ['query', 'Log query'], ['costs', 'Cost Explorer'], ['metrics', 'CloudWatch metrics']];
  const notChecked = (list, why) => { for (const [key, lbl] of list) add(key, false, lbl, `Not checked: ${why}`); };
  try {
    const miss = problems();
    if (miss.length) {
      add('credentials', false, 'AWS credentials', `Not configured: ${miss.join(', ')}`);
      notChecked(ALL.slice(1), 'no credentials');
      return finish();
    }
    const c = aws.build();
    try {
      const who = await aws.send(c.sts, new GetCallerIdentityCommand({}));
      add('credentials', true, 'AWS credentials', `Authenticated as ${maskArn(who.Arn)}${c.assumed ? ' (after assuming the configured role)' : ''}`);
    } catch (e) {
      add('credentials', false, 'AWS credentials', e.message);
      notChecked(ALL.slice(1), 'the credentials were not accepted');
      return finish();
    }

    const group = logGroup();
    // logging
    try {
      const r = await aws.send(c.bedrock, new GetModelInvocationLoggingConfigurationCommand({}));
      const cfg = r.loggingConfig || null;
      const cw = cfg && cfg.cloudWatchConfig && cfg.cloudWatchConfig.logGroupName ? cfg.cloudWatchConfig.logGroupName : '';
      const s3 = cfg && cfg.s3Config && cfg.s3Config.bucketName ? cfg.s3Config.bucketName : '';
      if (!cw && !s3) {
        add('logging', !group, 'Invocation logging', group ? 'Invocation logging is off in this Region, so the log group will stay empty. Switch it on in the Bedrock console.' : 'Invocation logging is off; the connector will use per-model metrics without users');
      } else if (!group) {
        add('logging', true, 'Invocation logging', `On, writing to ${cw ? `CloudWatch group ${cw}` : `S3 bucket ${s3}`}. bedrock.log_group is blank, so per-user data is not read`);
      } else if (!cw) {
        add('logging', false, 'Invocation logging', `On, but only to S3 bucket ${s3}. This connector reads CloudWatch Logs; add a CloudWatch destination`);
      } else if (cw !== group) {
        add('logging', false, 'Invocation logging', `On, writing to ${cw}, but bedrock.log_group is ${group}`);
      } else add('logging', true, 'Invocation logging', `On, writing to CloudWatch group ${cw}${s3 ? ` and S3 bucket ${s3}` : ''}`);
    } catch (e) {
      add('logging', false, 'Invocation logging', e.message);
    }

    // log group and the real history floor
    const rule = identityRule();
    let models = [];
    if (!group) {
      add('log_group', true, 'Log group', 'bedrock.log_group is blank, skipped');
      add('query', true, 'Log query', 'Skipped (no log group)');
    } else {
      let found = null;
      try {
        const r = await aws.send(c.logs, new DescribeLogGroupsCommand({ logGroupNamePrefix: group }));
        found = (r.logGroups || []).find((x) => x.logGroupName === group) || null;
        if (!found) add('log_group', false, 'Log group', `No log group named ${group} was found in ${c.region}`);
      } catch (e) {
        add('log_group', false, 'Log group', e.message);
      }
      if (found) {
        const created = found.creationTime ? Number(found.creationTime) : 0;
        const startMs = Math.max(created, Date.now() - 455 * win.DAY);
        try {
          const rows = await runQuery(c, group, 'stats min(@timestamp) as first_event', startMs, Date.now());
          const f = fieldsOf(rows[0]);
          add('log_group', true, 'Log group', f.first_event ? `Found ${group}; the first event in it is at ${f.first_event} (the real history floor)` : `Found ${group}; it holds no events yet`);
        } catch (e) {
          add('log_group', false, 'Log group', `Found ${group} but the first-event query failed: ${e.message}`);
        }
        const today = new Date().toISOString().slice(0, 10);
        const day = win.addDays(today, -1);
        try {
          const rows = await runQuery(c, group, queryString(rule, metadataKey()), win.toMs(day), win.toMs(today));
          const sample = fieldsOf(rows[0]);
          models = [...new Set(rows.map((r) => fieldsOf(r).model).filter(Boolean))];
          add('query', true, 'Log query', rows.length
            ? `${rows.length} rows for ${day} (UTC). Sample identity shape: ${sampleShape(rule, sample)}`
            : `The query ran and returned no rows for ${day} (UTC); there may be no traffic that day`);
        } catch (e) {
          add('query', false, 'Log query', e.message);
        }
      } else add('query', false, 'Log query', 'Not checked: the log group was not found');
    }

    // costs
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await costRows(c, win.addDays(today, -3), win.addDays(today, -1), costServices());
      const uts = [...new Set(rows.map((r) => r.ut))];
      const segs = [...new Set(uts.map((u) => parseUsageType(u).model).filter(Boolean))];
      const matched = models.length ? segs.filter((sg) => models.some((m) => modelKeyMatch(sg, m))).length : null;
      add('costs', true, 'Cost Explorer', `${uts.length} usage type${uts.length === 1 ? '' : 's'} over ${segs.length} model name${segs.length === 1 ? '' : 's'} in the last days of ${costServices().join(', ')}${matched === null ? '; model matching was not checked (no log models)' : `; ${matched} of ${segs.length} match a model seen in the logs`}`);
    } catch (e) {
      add('costs', false, 'Cost Explorer', e.message);
    }

    // metrics
    try {
      const ids = await listModelIds(c);
      add('metrics', true, 'CloudWatch metrics', ids.length
        ? `${ids.length} ModelId value${ids.length === 1 ? '' : 's'} in AWS/Bedrock metrics in ${c.region}`
        : `No ModelId values in AWS/Bedrock metrics in ${c.region}${group ? '' : '; with no log group, no tokens can be read'}`);
    } catch (e) {
      add('metrics', false, 'CloudWatch metrics', e.message);
    }
  } catch (e) {
    add('credentials', false, 'AWS credentials', e.message || String(e));
  }
  return finish();
}

module.exports = {
  id, label, platform, describe, problems, enabled, rebuildDays, historyFloor, maxDaysBack: null, test, pull,
  modelKeyMatch, parseUsageType, normalizeModelId, whoOf, queryString, allocate, maskArn, shapeOf,
  setRowCap, setPoll, setQueryTimeout, UNATTRIBUTED, USAGETYPE_KEY,
};
