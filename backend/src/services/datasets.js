'use strict';
// Dataset lifecycle: list, get, active, verify, promote, rollback, purge.
const { getDb } = require('../db');
const { conflict, notFound } = require('../errors');
const { broadcast } = require('./events');
const { nowIso, todayPhoenix } = require('./time');
const verifyEngine = require('./verify');

let warnedRollups = false;
function rollupsModule() {
  try {
    return require('./rollups');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /rollups/.test(e.message)) {
      if (!warnedRollups) {
        warnedRollups = true;
        console.warn('[datasets] services/rollups.js is not present; promote skips rollups');
      }
      return null;
    }
    throw e;
  }
}

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

function shape(row, db) {
  if (!row) return null;
  const platforms = db
    .prepare('SELECT platform, row_count AS rows, min_date, max_date, export_date, cost_usd FROM dataset_platforms WHERE dataset_id = ? ORDER BY platform')
    .all(row.id);
  return {
    id: row.id, label: row.label, source: row.source, seed: row.seed, status: row.status, verdict: row.verdict,
    created_at: row.created_at, verified_at: row.verified_at, promoted_at: row.promoted_at, archived_at: row.archived_at,
    file_hash: row.file_hash, options: parseJson(row.options_json, {}), counts: parseJson(row.counts_json, {}),
    note: row.note, platforms,
  };
}

function list() {
  const db = getDb();
  return db.prepare('SELECT * FROM datasets ORDER BY id DESC').all().map((r) => shape(r, db));
}

function get(id) {
  const db = getDb();
  return shape(db.prepare('SELECT * FROM datasets WHERE id = ?').get(id), db);
}

function active() {
  const db = getDb();
  return shape(db.prepare("SELECT * FROM datasets WHERE status = 'active'").get(), db);
}

function healthSummary() {
  const db = getDb();
  const a = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get();
  const counts = { datasets: db.prepare('SELECT count(*) AS n FROM datasets').get().n, usage_rows: 0, people: 0, platforms: 0 };
  if (a) {
    counts.usage_rows = db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ?').get(a.id).n;
    counts.people = db.prepare('SELECT count(*) AS n FROM people WHERE dataset_id = ?').get(a.id).n;
    counts.platforms = db.prepare('SELECT count(DISTINCT platform) AS n FROM usage WHERE dataset_id = ?').get(a.id).n;
  }
  return { activeDatasetId: a ? a.id : null, counts };
}

function settingsObject(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = parseJson(r.value, null);
  return out;
}

// Previous dataset to compare against: the active one (if it is not this dataset), else the newest archived.
function defaultCompareTo(db, id) {
  const a = db.prepare("SELECT id FROM datasets WHERE status = 'active' AND id <> ?").get(id);
  if (a) return a.id;
  const r = db
    .prepare("SELECT id FROM datasets WHERE status = 'archived' AND id <> ? ORDER BY coalesce(promoted_at, created_at) DESC, id DESC LIMIT 1")
    .get(id);
  return r ? r.id : null;
}

function runRow(db, runId) {
  const run = db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(runId);
  const results = db.prepare('SELECT * FROM verification_results WHERE run_id = ? ORDER BY id').all(runId).map((r) => ({
    ...r, metrics: parseJson(r.metrics_json, {}), evidence: parseJson(r.evidence_json, { columns: [], rows: [], total: 0 }),
  }));
  return {
    id: run.id, dataset_id: run.dataset_id, ran_at: run.ran_at, verdict: run.verdict, fail_count: run.fail_count,
    warn_count: run.warn_count, info_count: run.info_count, pass_count: run.pass_count, duration_ms: run.duration_ms,
    compared_to_dataset_id: run.compared_to_dataset_id, results,
  };
}

function verify(id, opts = {}) {
  const db = getDb();
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id);
  if (!ds) throw notFound('Dataset');
  const prev = opts.compareTo === undefined ? defaultCompareTo(db, id) : opts.compareTo;
  const out = verifyEngine.run({
    db, datasetId: id, prevDatasetId: prev || null, settings: settingsObject(db), today: todayPhoenix(),
  });
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO verification_runs (dataset_id, ran_at, verdict, fail_count, warn_count, info_count, pass_count, duration_ms, compared_to_dataset_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, nowIso(), out.verdict, out.fail_count, out.warn_count, out.info_count, out.pass_count, out.duration_ms, out.compared_to_dataset_id);
    const runId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO verification_results (run_id, check_id, severity, status, platform, title, message, metrics_json, evidence_json, affected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of out.results) {
      ins.run(runId, r.check_id, r.severity, r.status, r.platform, r.title, r.message,
        JSON.stringify(r.metrics || {}), JSON.stringify(r.evidence || {}), r.affected || 0);
    }
    const status = ds.status === 'staging' ? 'verified' : ds.status;
    db.prepare('UPDATE datasets SET verdict = ?, verified_at = ?, status = ? WHERE id = ?').run(out.verdict, nowIso(), status, id);
    return runId;
  });
  const runId = tx();
  broadcast('dataset.verified', { id, verdict: out.verdict });
  return runRow(db, runId);
}

function fillPlatforms(db, id) {
  const exportDate = (parseJson((db.prepare('SELECT options_json FROM datasets WHERE id = ?').get(id) || {}).options_json, {}) || {}).exportDate || null;
  db.prepare('DELETE FROM dataset_platforms WHERE dataset_id = ?').run(id);
  db.prepare(
    `INSERT INTO dataset_platforms (dataset_id, platform, min_date, max_date, export_date, row_count, cost_usd, tokens, credits, consumption)
     SELECT dataset_id, platform, min(date), max(date), ?, count(*), sum(cost_usd), sum(tokens), sum(credits), sum(consumption)
     FROM usage WHERE dataset_id = ? GROUP BY platform`
  ).run(exportDate, id);
}

function activate(id, opts) {
  const db = getDb();
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id);
  if (!ds) throw notFound('Dataset');
  if (ds.status === 'active') return get(id);
  if (!opts.skipChecks) {
    if (ds.status === 'staging' || !ds.verdict) throw conflict('Dataset has not been verified');
    if (ds.verdict === 'fail' && !opts.force) throw conflict('Dataset failed verification; promote with force to override');
  }
  if (ds.status === 'archived' && !db.prepare('SELECT 1 FROM usage WHERE dataset_id = ? LIMIT 1').get(id)) {
    throw conflict('Archived dataset no longer has usage rows (purged)');
  }
  const tx = db.transaction(() => {
    const now = nowIso();
    const cur = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get();
    if (cur) db.prepare("UPDATE datasets SET status = 'archived', archived_at = ? WHERE id = ?").run(now, cur.id);
    const rollups = rollupsModule();
    if (rollups) {
      const has = db.prepare('SELECT 1 FROM rollup_platform_day WHERE dataset_id = ? LIMIT 1').get(id);
      if (!has || !opts.rollback) rollups.build(db, id);
    }
    fillPlatforms(db, id);
    db.prepare("UPDATE datasets SET status = 'active', promoted_at = ?, archived_at = NULL WHERE id = ?").run(now, id);
  });
  tx();
  broadcast('dataset.promoted', { id });
  return get(id);
}

function promote(id, opts = {}) {
  return activate(id, { force: !!opts.force });
}

// Promote an archived dataset without re-verifying it.
function rollback(toId) {
  const db = getDb();
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(toId);
  if (!ds) throw notFound('Dataset');
  if (ds.status !== 'archived') throw conflict('Only an archived dataset can be rolled back to');
  return activate(toId, { skipChecks: true, rollback: true });
}

// Retention: stage rows of archived datasets beyond datasets.keep; usage rows beyond the newest 2 archived.
function purge() {
  const db = getDb();
  const keepRow = db.prepare("SELECT value FROM settings WHERE key = 'datasets.keep'").get();
  const keep = keepRow ? Number(parseJson(keepRow.value, 5)) : 5;
  const archived = db.prepare("SELECT id FROM datasets WHERE status = 'archived' ORDER BY coalesce(archived_at, created_at) DESC, id DESC").all();
  const out = { stagePurged: [], usagePurged: [] };
  const rollups = rollupsModule();
  db.transaction(() => {
    archived.forEach((r, idx) => {
      if (idx >= keep) {
        for (const t of ['stage_usage', 'stage_people', 'stage_seat_rate', 'stage_region_map', 'stage_lob_cg_map']) {
          db.prepare(`DELETE FROM ${t} WHERE dataset_id = ?`).run(r.id);
        }
        out.stagePurged.push(r.id);
      }
      if (idx >= 2) {
        db.prepare('DELETE FROM usage WHERE dataset_id = ?').run(r.id);
        if (rollups && typeof rollups.drop === 'function') rollups.drop(db, r.id);
        out.usagePurged.push(r.id);
      }
    });
  })();
  return out;
}

module.exports = { list, get, active, healthSummary, verify, promote, rollback, purge };
