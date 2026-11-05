'use strict';
// SQLite handle, schema (CONTRACT section 3) and settings seed.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULTS } = require('./defaults');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY,
  label TEXT,
  source TEXT NOT NULL DEFAULT 'fixture',
  status TEXT NOT NULL DEFAULT 'staging',
  created_at TEXT,
  verified_at TEXT,
  promoted_at TEXT,
  archived_at TEXT,
  file_hash TEXT,
  seed INTEGER,
  options_json TEXT,
  verdict TEXT,
  counts_json TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_datasets_file_hash ON datasets(file_hash) WHERE file_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_datasets_active ON datasets(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dataset_platforms (
  dataset_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  min_date TEXT,
  max_date TEXT,
  export_date TEXT,
  row_count INTEGER,
  cost_usd REAL,
  tokens REAL,
  credits REAL,
  consumption REAL,
  PRIMARY KEY (dataset_id, platform)
);

CREATE TABLE IF NOT EXISTS stage_usage (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL,
  row_no INTEGER,
  date TEXT,
  person_key TEXT,
  platform TEXT,
  model TEXT,
  tokens TEXT,
  credits TEXT,
  consumption TEXT,
  consumption_unit TEXT,
  cost_usd TEXT,
  requests TEXT,
  discount_amount TEXT,
  net_amount TEXT,
  email TEXT,
  extra_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_stage_usage_ds ON stage_usage(dataset_id);

CREATE TABLE IF NOT EXISTS stage_people (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL,
  row_no INTEGER,
  person_key TEXT,
  email TEXT,
  user_id TEXT,
  display_name TEXT,
  u_lob_2 TEXT,
  job_function TEXT,
  office_code TEXT,
  u_bo_fier_sbl TEXT,
  u_cg_person_type_code TEXT,
  extract_as_of TEXT,
  extra_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_stage_people_ds ON stage_people(dataset_id);

CREATE TABLE IF NOT EXISTS stage_seat_rate (
  dataset_id INTEGER NOT NULL,
  row_no INTEGER,
  platform TEXT,
  month TEXT,
  rate_usd TEXT,
  licensed_seats TEXT
);
CREATE INDEX IF NOT EXISTS ix_stage_seat_rate_ds ON stage_seat_rate(dataset_id);

CREATE TABLE IF NOT EXISTS stage_region_map (
  dataset_id INTEGER NOT NULL,
  row_no INTEGER,
  office_code TEXT,
  region TEXT
);
CREATE INDEX IF NOT EXISTS ix_stage_region_map_ds ON stage_region_map(dataset_id);

CREATE TABLE IF NOT EXISTS stage_lob_cg_map (
  dataset_id INTEGER NOT NULL,
  row_no INTEGER,
  job_function TEXT,
  u_lob_2 TEXT,
  lob_cg TEXT,
  lob_cg_sort TEXT
);
CREATE INDEX IF NOT EXISTS ix_stage_lob_cg_map_ds ON stage_lob_cg_map(dataset_id);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  person_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  tokens REAL NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  consumption REAL NOT NULL DEFAULT 0,
  consumption_unit TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_source TEXT,
  requests INTEGER,
  discount_amount REAL,
  net_amount REAL,
  matched INTEGER NOT NULL DEFAULT 0,
  snapshot_rank INTEGER
);
CREATE INDEX IF NOT EXISTS ix_usage_ds_date ON usage(dataset_id, date);
CREATE INDEX IF NOT EXISTS ix_usage_ds_plat_date ON usage(dataset_id, platform, date);
CREATE INDEX IF NOT EXISTS ix_usage_ds_person ON usage(dataset_id, person_key, platform);
CREATE INDEX IF NOT EXISTS ix_usage_grain ON usage(dataset_id, date, person_key, platform, model);

CREATE TABLE IF NOT EXISTS people (
  dataset_id INTEGER NOT NULL,
  person_key TEXT NOT NULL,
  email TEXT,
  user_id TEXT,
  display_name TEXT,
  u_lob_2 TEXT,
  job_function TEXT,
  lob_cg TEXT,
  lob_cg_sort INTEGER,
  office_code TEXT,
  region TEXT,
  sbl TEXT,
  person_type TEXT,
  extract_as_of TEXT,
  PRIMARY KEY (dataset_id, person_key)
);

CREATE TABLE IF NOT EXISTS seat_rate (
  dataset_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  month TEXT NOT NULL,
  rate_usd REAL,
  licensed_seats REAL,
  PRIMARY KEY (dataset_id, platform, month)
);

CREATE TABLE IF NOT EXISTS region_map (
  dataset_id INTEGER NOT NULL,
  office_code TEXT NOT NULL,
  region TEXT,
  PRIMARY KEY (dataset_id, office_code)
);

CREATE TABLE IF NOT EXISTS lob_cg_map (
  dataset_id INTEGER NOT NULL,
  job_function TEXT NOT NULL,
  u_lob_2 TEXT NOT NULL,
  lob_cg TEXT,
  lob_cg_sort INTEGER,
  PRIMARY KEY (dataset_id, job_function, u_lob_2)
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL,
  ran_at TEXT,
  verdict TEXT,
  fail_count INTEGER,
  warn_count INTEGER,
  info_count INTEGER,
  pass_count INTEGER,
  duration_ms INTEGER,
  compared_to_dataset_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_vruns_ds ON verification_runs(dataset_id, id);

CREATE TABLE IF NOT EXISTS verification_results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  severity TEXT,
  status TEXT,
  platform TEXT,
  title TEXT,
  message TEXT,
  metrics_json TEXT,
  evidence_json TEXT,
  affected INTEGER
);
CREATE INDEX IF NOT EXISTS ix_vr_run ON verification_results(run_id, check_id);

CREATE TABLE IF NOT EXISTS rollup_platform_day (
  dataset_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  rows INTEGER,
  cost_usd REAL,
  tokens REAL,
  credits REAL,
  consumption REAL,
  requests REAL,
  active_users INTEGER,
  matched_cost_usd REAL,
  unmatched_cost_usd REAL,
  PRIMARY KEY (dataset_id, platform, date)
);

CREATE TABLE IF NOT EXISTS rollup_model_day (
  dataset_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  rows INTEGER,
  cost_usd REAL,
  tokens REAL,
  credits REAL,
  consumption REAL,
  requests REAL,
  active_users INTEGER,
  PRIMARY KEY (dataset_id, platform, model, date)
);

CREATE TABLE IF NOT EXISTS rollup_person_day (
  dataset_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  person_key TEXT NOT NULL,
  rows INTEGER,
  cost_usd REAL,
  tokens REAL,
  credits REAL,
  consumption REAL,
  requests REAL,
  PRIMARY KEY (dataset_id, person_key, platform, date)
);

CREATE TABLE IF NOT EXISTS rollup_org_month (
  dataset_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  platform TEXT NOT NULL,
  lob_cg TEXT,
  lob_cg_sort INTEGER,
  region TEXT,
  sbl TEXT,
  person_type TEXT,
  matched INTEGER,
  rows INTEGER,
  cost_usd REAL,
  tokens REAL,
  credits REAL,
  consumption REAL,
  active_users INTEGER
);
CREATE INDEX IF NOT EXISTS ix_rollup_org_month ON rollup_org_month(dataset_id, month, platform);

CREATE TABLE IF NOT EXISTS rollup_person_month (
  dataset_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  platform TEXT NOT NULL,
  person_key TEXT NOT NULL,
  cost_usd REAL,
  tokens REAL,
  credits REAL,
  consumption REAL,
  active_days INTEGER,
  PRIMARY KEY (dataset_id, person_key, platform, month)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  password_hash TEXT,
  default_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  ad_dn TEXT,
  ad_sid TEXT,
  ad_upn TEXT,
  ad_guid TEXT,
  ad_groups_json TEXT,
  ad_ou TEXT,
  ad_attrs_json TEXT,
  person_key TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_login_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  system INTEGER NOT NULL DEFAULT 0,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS role_assignments (
  id INTEGER PRIMARY KEY,
  role_id INTEGER NOT NULL,
  subject_type TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  ad_dn TEXT NOT NULL DEFAULT '',
  ad_sid TEXT,
  ad_name TEXT,
  created_at TEXT,
  UNIQUE (role_id, subject_type, user_id, ad_dn)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  last_seen_at TEXT,
  expires_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  username TEXT,
  user_id INTEGER,
  source TEXT,
  ip TEXT,
  detail TEXT,
  actor_user_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_auth_events_at ON auth_events(at);

CREATE TABLE IF NOT EXISTS scope_grants (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  ad_dn TEXT NOT NULL DEFAULT '',
  ad_sid TEXT,
  ad_name TEXT,
  dim TEXT NOT NULL DEFAULT 'lob_cg',
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER,
  UNIQUE (subject_type, user_id, ad_dn, dim, value)
);
-- section 16.4 (N)
CREATE TABLE IF NOT EXISTS vendor_org_values (
  id INTEGER PRIMARY KEY,
  vendor TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized TEXT NOT NULL DEFAULT '',
  lob_cg TEXT,
  match_method TEXT,
  score REAL,
  confirmed_by INTEGER,
  confirmed_at TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  people_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vendor, value)
);

CREATE TABLE IF NOT EXISTS vendor_org_aliases (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL,
  lob_cg TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT,
  UNIQUE (alias)
);

CREATE TABLE IF NOT EXISTS vendor_org_people (
  vendor TEXT NOT NULL,
  person_key TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  value TEXT NOT NULL,
  seen_at TEXT,
  PRIMARY KEY (vendor, person_key, value)
);
CREATE INDEX IF NOT EXISTS ix_vendor_org_people_key ON vendor_org_people(person_key);

-- section 16.1 (M): vendor usage detail, keeps the product breakdown the usage grain cannot hold.
CREATE TABLE IF NOT EXISTS vendor_usage_detail (
  vendor TEXT NOT NULL,
  date TEXT NOT NULL,
  person_key TEXT NOT NULL,
  email TEXT,
  model TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  tokens REAL,
  cost_usd REAL,
  list_cost_usd REAL,
  requests INTEGER,
  pulled_at TEXT,
  PRIMARY KEY (vendor, date, person_key, model, product)
);
CREATE INDEX IF NOT EXISTS ix_vendor_detail_person ON vendor_usage_detail(vendor, person_key, date);
`;

let db = null;
let openPath = null;

function dbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'aixp.db');
}

function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// Hand ALTERs for columns added after the first release: [table, column, DDL type].
const ALTERS = [
  ['people', 'origin', "TEXT NOT NULL DEFAULT 'extract'"], // section 16.4 (N)
];

function open() {
  const p = dbPath();
  if (db && openPath === p) return db;
  if (db) close();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p);
  openPath = p;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  for (const [table, col, type] of ALTERS) {
    if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULTS)) seed.run(k, JSON.stringify(v));
  });
  tx();
  return db;
}

function getDb() {
  return db || open();
}

function close() {
  if (db) {
    try { db.close(); } catch (e) { /* already closed */ }
  }
  db = null;
  openPath = null;
}

module.exports = { open, getDb, close, dbPath, SCHEMA };
