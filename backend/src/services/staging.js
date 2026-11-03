'use strict';
// Staging: create a dataset and load raw tables as TEXT, exactly as given.
const { getDb } = require('../db');
const { nowIso } = require('./time');

// Header synonyms. Keys are the lowercase header with every non-alphanumeric removed.
const SYN = {
  date: 'date', filedate: 'date', reportdate: 'date', reportingdate: 'date', usagedate: 'date',
  personkey: 'person_key', alias: 'person_key', useralias: 'person_key', username: 'person_key',
  userkey: 'person_key', person: 'person_key',
  platform: 'platform', source: 'platform', vendor: 'platform',
  model: 'model', modelname: 'model',
  tokens: 'tokens', totaltokens: 'tokens',
  credits: 'credits', quantity: 'credits', monthlycreditsused: 'credits', billingcostvalue: 'credits',
  consumption: 'consumption',
  consumptionunit: 'consumption_unit', unit: 'consumption_unit',
  costusd: 'cost_usd', amountusd: 'cost_usd', grossamount: 'cost_usd', billingestimatedcostusdvalue: 'cost_usd',
  cost: 'cost_usd',
  requests: 'requests', requestcount: 'requests',
  discountamount: 'discount_amount', discount: 'discount_amount',
  netamount: 'net_amount',
  email: 'email', useremail: 'email', emailaddress: 'email', emailkey: 'email', mail: 'email',
  userid: 'user_id',
  displayname: 'display_name', name: 'display_name', fullname: 'display_name',
  ulob2: 'u_lob_2', jobfunction: 'job_function',
  officecode: 'office_code', office: 'office_code',
  ubofiersbl: 'u_bo_fier_sbl', sbl: 'u_bo_fier_sbl',
  ucgpersontypecode: 'u_cg_person_type_code', persontypecode: 'u_cg_person_type_code',
  extractasof: 'extract_as_of', asofdate: 'extract_as_of', extractdate: 'extract_as_of',
  rateusd: 'rate_usd', rate: 'rate_usd',
  licensedseats: 'licensed_seats', seats: 'licensed_seats',
  month: 'month',
  region: 'region',
  lobcg: 'lob_cg', lobcgsort: 'lob_cg_sort',
};

// "Table[Column]" -> Column; trim, lowercase, collapse spaces, resolve synonyms.
function headerKey(name) {
  let s = String(name == null ? '' : name);
  const m = s.match(/^[^[]*\[(.*)\]\s*$/);
  if (m) s = m[1];
  s = s.replace(/\u00a0/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  const compact = s.replace(/[^a-z0-9]/g, '');
  if (SYN[compact]) return SYN[compact];
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const TABLES = {
  usage: {
    table: 'stage_usage',
    cols: ['date', 'person_key', 'platform', 'model', 'tokens', 'credits', 'consumption',
      'consumption_unit', 'cost_usd', 'requests', 'discount_amount', 'net_amount', 'email'],
    extra: true,
  },
  people: {
    table: 'stage_people',
    cols: ['person_key', 'email', 'user_id', 'display_name', 'u_lob_2', 'job_function', 'office_code',
      'u_bo_fier_sbl', 'u_cg_person_type_code', 'extract_as_of'],
    extra: true,
  },
  seatRate: { table: 'stage_seat_rate', cols: ['platform', 'month', 'rate_usd', 'licensed_seats'], extra: false },
  regionMap: { table: 'stage_region_map', cols: ['office_code', 'region'], extra: false },
  lobCgMap: { table: 'stage_lob_cg_map', cols: ['job_function', 'u_lob_2', 'lob_cg', 'lob_cg_sort'], extra: false },
};

function createDataset({ label, source = 'fixture', seed = null, options = {}, file_hash = null } = {}) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO datasets (label, source, status, created_at, file_hash, seed, options_json, counts_json)
       VALUES (?, ?, 'staging', ?, ?, ?, ?, '{}')`
    )
    .run(label || 'Dataset', source, nowIso(), file_hash, seed, JSON.stringify(options || {}));
  return Number(info.lastInsertRowid);
}

function str(v) {
  if (v === undefined || v === null) return null;
  return String(v);
}

function loadOne(db, datasetId, spec, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const cols = ['dataset_id', 'row_no'].concat(spec.cols).concat(spec.extra ? ['extra_json'] : []);
  const stmt = db.prepare(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const keyCache = new Map();
  const colSet = new Set(spec.cols);
  const CHUNK = 5000;
  let rowNo = 0;
  for (let off = 0; off < rows.length; off += CHUNK) {
    const end = Math.min(rows.length, off + CHUNK);
    for (let i = off; i < end; i++) {
      const row = rows[i];
      rowNo += 1;
      const vals = {};
      let extra = null;
      for (const k of Object.keys(row)) {
        let hk = keyCache.get(k);
        if (hk === undefined) {
          hk = headerKey(k);
          keyCache.set(k, hk);
        }
        if (colSet.has(hk)) {
          if (vals[hk] === undefined) vals[hk] = row[k];
        } else if (spec.extra) {
          if (!extra) extra = {};
          extra[k] = row[k];
        }
      }
      const params = [datasetId, rowNo];
      for (const c of spec.cols) params.push(str(vals[c]));
      if (spec.extra) params.push(extra ? JSON.stringify(extra) : null);
      stmt.run(params);
    }
  }
  return rowNo;
}

// tables = {usage, people, seatRate, regionMap, lobCgMap}: arrays of plain objects keyed by primer columns.
function loadTables(datasetId, tables) {
  const db = getDb();
  const counts = {};
  const tx = db.transaction(() => {
    for (const [name, spec] of Object.entries(TABLES)) {
      db.prepare(`DELETE FROM ${spec.table} WHERE dataset_id = ?`).run(datasetId);
      counts[name] = loadOne(db, datasetId, spec, (tables || {})[name]);
    }
    const ds = db.prepare('SELECT counts_json FROM datasets WHERE id = ?').get(datasetId);
    let cj = {};
    try { cj = JSON.parse((ds && ds.counts_json) || '{}'); } catch (e) { cj = {}; }
    cj.stage = counts;
    db.prepare('UPDATE datasets SET counts_json = ? WHERE id = ?').run(JSON.stringify(cj), datasetId);
  });
  tx();
  return counts;
}

module.exports = { createDataset, loadTables, headerKey };
