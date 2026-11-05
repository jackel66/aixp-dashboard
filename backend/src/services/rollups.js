'use strict';
// Rollup tables (CONTRACT section 3). build() is synchronous and uses no transaction of its own,
// so datasets.promote can call it inside its transaction. Seat spend is never written here:
// rollups only aggregate usage rows.

const ACTIVE = '(coalesce(cost_usd, 0) > 0 OR coalesce(tokens, 0) > 0 OR coalesce(credits, 0) > 0)';
const TABLES = [
  'rollup_platform_day', 'rollup_model_day', 'rollup_person_day', 'rollup_org_month', 'rollup_person_month',
];

const indexed = new WeakSet();
function ensureIndexes(db) {
  if (indexed.has(db)) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_rpd_ds_date ON rollup_person_day(dataset_id, date, platform);
    CREATE INDEX IF NOT EXISTS ix_rpd_ds_plat_date ON rollup_person_day(dataset_id, platform, date);
    CREATE INDEX IF NOT EXISTS ix_rmd_ds_date ON rollup_model_day(dataset_id, date);
    CREATE INDEX IF NOT EXISTS ix_rpm_ds_month ON rollup_person_month(dataset_id, month, platform);
    CREATE INDEX IF NOT EXISTS ix_usage_ds_plat_model ON usage(dataset_id, platform, model, date);
    CREATE INDEX IF NOT EXISTS idx_rpd_platform_date ON rollup_person_day(dataset_id, platform, date);
    CREATE INDEX IF NOT EXISTS idx_people_lob ON people(dataset_id, lob_cg);
  `);
  indexed.add(db);
}

function drop(db, datasetId) {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t} WHERE dataset_id = ?`).run(datasetId);
}

const ORG_SQL = `
  INSERT INTO rollup_org_month (dataset_id, month, platform, lob_cg, lob_cg_sort, region, sbl, person_type, matched,
    rows, cost_usd, tokens, credits, consumption, active_users)
  SELECT u.dataset_id, substr(u.date, 1, 7), u.platform, p.lob_cg, p.lob_cg_sort, p.region, p.sbl, p.person_type,
    CASE WHEN p.person_key IS NULL THEN 0 ELSE 1 END,
    count(*), coalesce(sum(u.cost_usd), 0), coalesce(sum(u.tokens), 0), coalesce(sum(u.credits), 0),
    coalesce(sum(u.consumption), 0),
    count(DISTINCT CASE WHEN ${ACTIVE.replace(/(cost_usd|tokens|credits)/g, 'u.$1')} THEN u.person_key END)
  FROM usage u
  LEFT JOIN people p ON p.dataset_id = u.dataset_id AND p.person_key = u.person_key
  WHERE u.dataset_id = ?
  GROUP BY u.platform, substr(u.date, 1, 7), p.lob_cg, p.lob_cg_sort, p.region, p.sbl, p.person_type,
    CASE WHEN p.person_key IS NULL THEN 0 ELSE 1 END`;

function rebuildOrg(db, datasetId) {
  db.prepare('DELETE FROM rollup_org_month WHERE dataset_id = ?').run(datasetId);
  db.prepare(ORG_SQL).run(datasetId);
}

function build(db, datasetId) {
  ensureIndexes(db);
  drop(db, datasetId);
  db.prepare(
    `INSERT INTO rollup_platform_day (dataset_id, date, platform, rows, cost_usd, tokens, credits, consumption, requests,
       active_users, matched_cost_usd, unmatched_cost_usd)
     SELECT dataset_id, date, platform, count(*), coalesce(sum(cost_usd), 0), coalesce(sum(tokens), 0),
       coalesce(sum(credits), 0), coalesce(sum(consumption), 0), coalesce(sum(requests), 0),
       count(DISTINCT CASE WHEN ${ACTIVE} THEN person_key END),
       coalesce(sum(CASE WHEN matched = 1 THEN cost_usd END), 0),
       coalesce(sum(CASE WHEN matched = 1 THEN 0 ELSE cost_usd END), 0)
     FROM usage WHERE dataset_id = ? GROUP BY date, platform`
  ).run(datasetId);
  db.prepare(
    `INSERT INTO rollup_model_day (dataset_id, date, platform, model, rows, cost_usd, tokens, credits, consumption,
       requests, active_users)
     SELECT dataset_id, date, platform, coalesce(model, ''), count(*), coalesce(sum(cost_usd), 0),
       coalesce(sum(tokens), 0), coalesce(sum(credits), 0), coalesce(sum(consumption), 0), coalesce(sum(requests), 0),
       count(DISTINCT CASE WHEN ${ACTIVE} THEN person_key END)
     FROM usage WHERE dataset_id = ? GROUP BY date, platform, coalesce(model, '')`
  ).run(datasetId);
  db.prepare(
    `INSERT INTO rollup_person_day (dataset_id, date, platform, person_key, rows, cost_usd, tokens, credits, consumption,
       requests)
     SELECT dataset_id, date, platform, coalesce(person_key, ''), count(*), coalesce(sum(cost_usd), 0),
       coalesce(sum(tokens), 0), coalesce(sum(credits), 0), coalesce(sum(consumption), 0), coalesce(sum(requests), 0)
     FROM usage WHERE dataset_id = ? GROUP BY date, platform, coalesce(person_key, '')`
  ).run(datasetId);
  db.prepare(
    `INSERT INTO rollup_person_month (dataset_id, month, platform, person_key, cost_usd, tokens, credits, consumption,
       active_days)
     SELECT dataset_id, substr(date, 1, 7), platform, person_key, sum(cost_usd), sum(tokens), sum(credits),
       sum(consumption), count(DISTINCT date)
     FROM rollup_person_day WHERE dataset_id = ? GROUP BY substr(date, 1, 7), platform, person_key`
  ).run(datasetId);
  db.prepare(ORG_SQL).run(datasetId);
}

module.exports = { build, drop, rebuildOrg, ensureIndexes, ACTIVE, TABLES };
