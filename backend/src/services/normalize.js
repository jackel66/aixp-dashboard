'use strict';
// Normalization: stage_* -> usage, people, seat_rate, region_map, lob_cg_map (CONTRACT section 5).
const { getDb } = require('../db');
const { idFor, PLATFORMS } = require('../platforms');

// ---- scalar helpers (also registered as SQL functions) ----------------------------------

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function parseDate(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\u00a0/g, ' ').trim();
  if (!t) return null;
  let y;
  let m;
  let d;
  let mt = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
  if (mt) {
    y = +mt[1]; m = +mt[2]; d = +mt[3];
  } else {
    mt = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|[ T])/);
    if (!mt) return null;
    m = +mt[1]; d = +mt[2]; y = +mt[3];
  }
  const ms = Date.UTC(y, m - 1, d);
  const chk = new Date(ms);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
  return chk.toISOString().slice(0, 10);
}

function isBlank(s) {
  return s === null || s === undefined || String(s).replace(/\u00a0/g, ' ').trim() === '';
}

// null when blank, NaN-free number otherwise; undefined when not numeric.
function parseNum(s) {
  if (isBlank(s)) return null;
  const t = String(s).replace(/\u00a0/g, ' ').trim();
  if (!NUM_RE.test(t)) return undefined;
  return Number(t);
}

// Lowercase, U+00A0 -> space, trim. No platform rule.
function keyRaw(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\u00a0/g, ' ').toLowerCase().trim();
}

// PersonKey for a usage row: keyRaw, plus the GitHub alias rule (trailing _capgroup).
function usageKey(s, pid) {
  let k = keyRaw(s);
  if (pid === 'github') k = k.replace(/_capgroup$/, '').trim();
  return k;
}

function emailNorm(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\u00a0/g, ' ').trim().toLowerCase();
}

const registered = new WeakSet();
function registerFunctions(db) {
  if (registered.has(db)) return;
  registered.add(db);
  const opt = { deterministic: true };
  db.function('aixp_date', opt, (s) => parseDate(s));
  db.function('aixp_numok', opt, (s) => (parseNum(s) === undefined ? 0 : 1));
  db.function('aixp_num', opt, (s) => {
    const v = parseNum(s);
    return v === undefined ? null : v;
  });
  db.function('aixp_platform', opt, (s) => idFor(s));
  db.function('aixp_keyraw', opt, (s) => keyRaw(s));
  db.function('aixp_ukey', opt, (s, pid) => usageKey(s, pid));
  db.function('aixp_email', opt, (s) => emailNorm(s));
}

// ---- settings ----------------------------------------------------------------------------

function readSetting(db, key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch (e) { return fallback; }
}

// ---- people ------------------------------------------------------------------------------

function trimStr(s) {
  return s === null || s === undefined ? '' : String(s).replace(/\u00a0/g, ' ').trim();
}

function personType(code) {
  const c = trimStr(code);
  if (!c) return 'Unknown';
  return c.toLowerCase() === 'employee' ? 'Associate' : 'Non-Associate';
}

function lobKey(jf, lob) {
  return `${trimStr(jf).toLowerCase()}\u0001${trimStr(lob).toLowerCase()}`;
}

function normalizePeople(db, datasetId, regionByOffice, lobByPair) {
  const rows = db
    .prepare('SELECT * FROM stage_people WHERE dataset_id = ? ORDER BY row_no')
    .all(datasetId);
  const best = new Map();
  let droppedBlank = 0;
  for (const r of rows) {
    const k = keyRaw(r.person_key);
    if (!k) { droppedBlank += 1; continue; }
    const asOf = parseDate(r.extract_as_of) || '';
    const hasLob = trimStr(r.u_lob_2) !== '';
    const cur = best.get(k);
    if (!cur) { best.set(k, { r, asOf, hasLob }); continue; }
    // Newest extract wins; tie: the row with u_lob_2; then first.
    if (asOf > cur.asOf || (asOf === cur.asOf && hasLob && !cur.hasLob)) best.set(k, { r, asOf, hasLob });
  }
  const ins = db.prepare(
    `INSERT INTO people (dataset_id, person_key, email, user_id, display_name, u_lob_2, job_function, lob_cg,
       lob_cg_sort, office_code, region, sbl, person_type, extract_as_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [k, { r, asOf }] of best) {
    const lob = lobByPair.get(lobKey(r.job_function, r.u_lob_2));
    const office = trimStr(r.office_code);
    const region = regionByOffice.get(office.toUpperCase()) || 'Unknown';
    const sbl = trimStr(r.u_bo_fier_sbl);
    ins.run(
      datasetId, k, emailNorm(r.email), trimStr(r.user_id).toUpperCase(), trimStr(r.display_name),
      trimStr(r.u_lob_2), trimStr(r.job_function),
      lob ? lob.lob_cg : 'Unassigned', lob ? lob.sort : 999,
      office, region, sbl || 'Unknown', personType(r.u_cg_person_type_code), asOf || null
    );
  }
  return { people: best.size, droppedBlank };
}

// ---- usage -------------------------------------------------------------------------------

// Inner query shared by the count, sample and insert statements.
// Layer 1 resolves platform; layer 2 derives date, key and numerics; "valid" is the reject rule.
const NORM_CTE = `
WITH l1 AS (
  SELECT s.*, aixp_platform(s.platform) AS pid FROM stage_usage s WHERE s.dataset_id = @ds
), l2 AS (
  SELECT l1.id, l1.row_no, l1.pid, aixp_date(l1.date) AS d, aixp_ukey(l1.person_key, l1.pid) AS k,
    CASE WHEN l1.pid IN ('anthropic', 'openai') THEN trim(coalesce(l1.model, '')) ELSE '' END AS model,
    coalesce(aixp_num(l1.tokens), 0) AS tokens, coalesce(aixp_num(l1.credits), 0) AS credits,
    aixp_num(l1.cost_usd) AS cost, aixp_num(l1.requests) AS requests,
    aixp_num(l1.discount_amount) AS disc, aixp_num(l1.net_amount) AS net,
    aixp_email(l1.email) AS email,
    CASE WHEN l1.pid IS NOT NULL AND aixp_date(l1.date) IS NOT NULL
      AND aixp_numok(l1.tokens) AND aixp_numok(l1.credits) AND aixp_numok(l1.cost_usd)
      AND aixp_numok(l1.requests) AND aixp_numok(l1.discount_amount) AND aixp_numok(l1.net_amount)
      THEN 1 ELSE 0 END AS valid,
    l1.date AS raw_date, l1.platform AS raw_platform, l1.person_key AS raw_key
  FROM l1
)`;

function normalizeUsage(db, datasetId, coworkRate) {
  const counts = db
    .prepare(
      `${NORM_CTE}
       SELECT pid, count(*) AS stage_rows, sum(valid) AS valid_rows,
         sum(CASE WHEN valid = 1 AND k = '' THEN 1 ELSE 0 END) AS blank_key,
         sum(CASE WHEN valid = 0 THEN 1 ELSE 0 END) AS rejected,
         sum(CASE WHEN valid = 1 THEN coalesce(cost, 0) ELSE 0 END) AS stage_cost
       FROM l2 GROUP BY pid`
    )
    .all({ ds: datasetId });

  const samplesRaw = db
    .prepare(
      `${NORM_CTE}
       SELECT row_no, raw_date, raw_platform, raw_key, pid, d, valid FROM l2 WHERE valid = 0 ORDER BY row_no LIMIT 20`
    )
    .all({ ds: datasetId });
  const samples = samplesRaw.map((r) => ({
    row_no: r.row_no,
    reason: !r.pid ? 'unknown platform' : r.d === null ? 'bad date' : 'non-numeric value',
    date: r.raw_date,
    platform: r.raw_platform,
    person_key: r.raw_key === null ? null : String(r.raw_key).replace(/\u00a0/g, '<nbsp>'),
  }));

  const insertCols = `dataset_id, date, person_key, platform, model, tokens, credits, consumption, consumption_unit,
    cost_usd, cost_source, requests, discount_amount, net_amount, matched, snapshot_rank`;
  const matchedExpr = `EXISTS (SELECT 1 FROM people p WHERE p.dataset_id = @ds AND p.person_key = k)`;

  db.prepare(
    `${NORM_CTE}
     INSERT INTO usage (${insertCols})
     SELECT @ds, d, k, pid, model, tokens, credits,
       CASE WHEN pid IN ('anthropic', 'openai') THEN tokens ELSE credits END,
       CASE WHEN pid IN ('anthropic', 'openai') THEN 'tokens' ELSE 'credits' END,
       coalesce(cost, 0), CASE WHEN cost IS NULL THEN 'none' ELSE 'vendor' END,
       CAST(requests AS INTEGER), disc, net, ${matchedExpr}, NULL
     FROM l2 WHERE valid = 1 AND k <> '' AND pid <> 'cowork' ORDER BY row_no`
  ).run({ ds: datasetId });

  // Cowork: latest snapshot per person + month; cost = credits x rate (derived).
  db.prepare(
    `${NORM_CTE}
     INSERT INTO usage (${insertCols})
     SELECT @ds, d, k, pid, '', 0, credits, credits, 'credits', round(credits * @rate, 6), 'derived',
       NULL, NULL, NULL, ${matchedExpr}, 1
     FROM (
       SELECT l2.*, row_number() OVER (PARTITION BY k, substr(d, 1, 7) ORDER BY d DESC, credits DESC, id DESC) AS rn
       FROM l2 WHERE valid = 1 AND k <> '' AND pid = 'cowork'
     ) WHERE rn = 1 ORDER BY row_no`
  ).run({ ds: datasetId, rate: coworkRate });

  return { counts, samples };
}

// ---- main --------------------------------------------------------------------------------

function normalize(datasetId) {
  const db = getDb();
  registerFunctions(db);
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(datasetId);
  if (!ds) throw new Error(`Dataset ${datasetId} not found`);
  const coworkRate = Number(readSetting(db, 'cowork.rate', 0.008));

  const result = {};
  const tx = db.transaction(() => {
    for (const t of ['usage', 'people', 'seat_rate', 'region_map', 'lob_cg_map']) {
      db.prepare(`DELETE FROM ${t} WHERE dataset_id = ?`).run(datasetId);
    }

    // Region map: one row per normalized office code, first wins.
    const regionByOffice = new Map();
    for (const r of db.prepare('SELECT * FROM stage_region_map WHERE dataset_id = ? ORDER BY row_no').all(datasetId)) {
      const code = trimStr(r.office_code).toUpperCase();
      if (!code || regionByOffice.has(code)) continue;
      regionByOffice.set(code, trimStr(r.region) || 'Unknown');
    }
    const insRegion = db.prepare('INSERT INTO region_map (dataset_id, office_code, region) VALUES (?, ?, ?)');
    for (const [code, region] of regionByOffice) insRegion.run(datasetId, code, region);

    // LOB-CG map: first row per (job_function, u_lob_2) wins.
    const lobByPair = new Map();
    const insLob = db.prepare(
      'INSERT INTO lob_cg_map (dataset_id, job_function, u_lob_2, lob_cg, lob_cg_sort) VALUES (?, ?, ?, ?, ?)'
    );
    for (const r of db.prepare('SELECT * FROM stage_lob_cg_map WHERE dataset_id = ? ORDER BY row_no').all(datasetId)) {
      const k = lobKey(r.job_function, r.u_lob_2);
      const label = trimStr(r.lob_cg);
      if (!label || lobByPair.has(k)) continue;
      const sortN = parseNum(r.lob_cg_sort);
      const sort = typeof sortN === 'number' ? Math.round(sortN) : 999;
      lobByPair.set(k, { lob_cg: label, sort });
      insLob.run(datasetId, trimStr(r.job_function), trimStr(r.u_lob_2), label, sort);
    }

    // Seat rate.
    const insSeat = db.prepare(
      'INSERT OR REPLACE INTO seat_rate (dataset_id, platform, month, rate_usd, licensed_seats) VALUES (?, ?, ?, ?, ?)'
    );
    let seatRejected = 0;
    for (const r of db.prepare('SELECT * FROM stage_seat_rate WHERE dataset_id = ? ORDER BY row_no').all(datasetId)) {
      const pid = idFor(r.platform);
      const month = (parseDate(r.month) || (/^\d{4}-\d{2}$/.test(trimStr(r.month)) ? `${trimStr(r.month)}-01` : null) || '').slice(0, 7);
      const rate = parseNum(r.rate_usd);
      const seats = parseNum(r.licensed_seats);
      if (!pid || !month || typeof rate !== 'number' || seats === undefined) { seatRejected += 1; continue; }
      insSeat.run(datasetId, pid, month, rate, seats === null ? 0 : seats);
    }

    const ppl = normalizePeople(db, datasetId, regionByOffice, lobByPair);
    const usage = normalizeUsage(db, datasetId, coworkRate);

    const keptRows = db.prepare('SELECT platform, count(*) AS n, sum(cost_usd) AS cost FROM usage WHERE dataset_id = ? GROUP BY platform').all(datasetId);
    const keptBy = {};
    for (const k of keptRows) keptBy[k.platform] = k;

    const byPlatform = {};
    for (const p of PLATFORMS) byPlatform[p.id] = { stageRows: 0, stageCost: 0, usageRows: 0, usageCost: 0, droppedBlankKey: 0, rejected: 0, coworkSnapshotsDropped: 0 };
    let rejectedTotal = 0;
    let droppedBlankKey = 0;
    let coworkDropped = 0;
    let stageTotal = 0;
    for (const c of usage.counts) {
      stageTotal += c.stage_rows;
      rejectedTotal += c.rejected;
      droppedBlankKey += c.blank_key;
      if (!c.pid) continue;
      const b = byPlatform[c.pid];
      const kept = keptBy[c.pid] || { n: 0, cost: 0 };
      b.stageRows = c.stage_rows;
      b.stageCost = c.stage_cost || 0;
      b.usageRows = kept.n;
      b.usageCost = kept.cost || 0;
      b.droppedBlankKey = c.blank_key;
      b.rejected = c.rejected;
      if (c.pid === 'cowork') {
        b.coworkSnapshotsDropped = Math.max(0, c.valid_rows - c.blank_key - kept.n);
        coworkDropped = b.coworkSnapshotsDropped;
      }
    }
    // Rows with an unknown platform have no bucket of their own.
    const unknownPlatformRejected = usage.counts.filter((c) => !c.pid).reduce((a, c) => a + c.rejected, 0);

    result.counts = {
      stageRows: stageTotal,
      usageRows: keptRows.reduce((a, k) => a + k.n, 0),
      people: ppl.people,
      droppedBlankKey,
      droppedBlankKeyPeople: ppl.droppedBlank,
      rejected: { count: rejectedTotal, unknownPlatform: unknownPlatformRejected, seatRate: seatRejected, samples: usage.samples },
      coworkSnapshotsDropped: coworkDropped,
      byPlatform,
    };

    let cj = {};
    try { cj = JSON.parse(ds.counts_json || '{}'); } catch (e) { cj = {}; }
    Object.assign(cj, result.counts);
    db.prepare('UPDATE datasets SET counts_json = ? WHERE id = ?').run(JSON.stringify(cj), datasetId);
  });
  tx();
  return result.counts;
}

module.exports = { normalize, parseDate, parseNum, keyRaw, usageKey, emailNorm, registerFunctions, trimStr };
