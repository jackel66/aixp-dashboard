'use strict';
// Vendor org correlation (CONTRACT section 16.4): vendor org values -> LOB-CG labels.
// Fuzzy matching only ever produces suggestions; a mapping is applied only through PUT, an alias,
// or an exact / normalized hit. People rows from the extract are never modified.
const { getDb } = require('../db');
const { badRequest, notFound, conflict } = require('../errors');
const { keyRaw, emailNorm, trimStr } = require('./normalize');
const { nowIso } = require('./time');

const SUGGEST_MIN = 0.8;
const SUGGEST_MAX = 3;
const FILLER = new Set(['the', 'and', 'of', 'dept', 'department', 'team', 'org', 'organisation', 'organization', 'group', 'lob', 'cg']);
const UNASSIGNED = new Set(['', 'unassigned', 'unknown']);

// ---- string helpers ------------------------------------------------------------------------

// Lowercase, trim, collapse whitespace, strip punctuation (hyphen, underscore and slash separate
// words, every other symbol is dropped), drop filler words, collapse spaces again. When nothing
// is left the punctuation-stripped form is returned so a value like "Group" still compares.
function normalizeOrg(s) {
  let t = String(s === null || s === undefined ? '' : s).replace(/\u00a0/g, ' ').toLowerCase();
  t = t.replace(/[-_/\\]+/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  const base = t;
  t = ` ${t} `.replace(/ line of business /g, ' ');
  const kept = t.split(' ').filter((w) => w && !FILLER.has(w));
  const out = kept.join(' ').trim();
  return out || base;
}

function tokens(s) {
  return Array.from(new Set(String(s || '').split(/\s+/).filter(Boolean)));
}

// 2 x shared tokens / (tokens a + tokens b), over unique tokens.
function tokenSetRatio(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  let shared = 0;
  for (const t of ta) if (sb.has(t)) shared += 1;
  return (2 * shared) / (ta.length + tb.length);
}

// Standard Jaro-Winkler, prefix scale 0.1, prefix capped at 4.
function jaroWinkler(a, b) {
  const s1 = String(a === null || a === undefined ? '' : a);
  const s2 = String(b === null || b === undefined ? '' : b);
  if (!s1.length && !s2.length) return 1;
  if (!s1.length || !s2.length) return 0;
  if (s1 === s2) return 1;
  const range = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i += 1) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(s2.length - 1, i + range);
    for (let j = lo; j <= hi; j += 1) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i += 1) {
    if (!m1[i]) continue;
    while (!m2[k]) k += 1;
    if (s1[i] !== s2[k]) t += 1;
    k += 1;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// ---- active dataset labels -----------------------------------------------------------------

function activeId(db) {
  const r = db.prepare("SELECT id FROM datasets WHERE status = 'active'").get();
  return r ? r.id : null;
}

// [{value, sort}] for the labels of a dataset (lob_cg_map first, then people), Unassigned excluded.
function lobValuesFor(db, datasetId) {
  if (!datasetId) return [];
  const best = new Map();
  const add = (label, sort) => {
    const v = trimStr(label);
    if (UNASSIGNED.has(v.toLowerCase())) return;
    const s = Number.isFinite(Number(sort)) ? Number(sort) : 999;
    if (!best.has(v) || s < best.get(v)) best.set(v, s);
  };
  for (const r of db.prepare('SELECT lob_cg, lob_cg_sort FROM lob_cg_map WHERE dataset_id = ?').all(datasetId)) add(r.lob_cg, r.lob_cg_sort);
  for (const r of db.prepare('SELECT lob_cg, min(lob_cg_sort) AS s FROM people WHERE dataset_id = ? GROUP BY lob_cg').all(datasetId)) add(r.lob_cg, r.s);
  return Array.from(best, ([value, sort]) => ({ value, sort })).sort((a, b) => a.sort - b.sort || (a.value < b.value ? -1 : 1));
}

function lobValues(db) {
  return lobValuesFor(db, activeId(db));
}

// ---- matching ------------------------------------------------------------------------------

function suggestionsFor(norm, labels) {
  const out = [];
  for (const l of labels) {
    const ln = normalizeOrg(l.value);
    const score = Math.max(tokenSetRatio(norm, ln), jaroWinkler(norm, ln));
    if (score >= SUGGEST_MIN) out.push({ lob_cg: l.value, score: round4(score), sort: l.sort });
  }
  out.sort((a, b) => b.score - a.score || a.sort - b.sort || (a.lob_cg < b.lob_cg ? -1 : 1));
  return out.slice(0, SUGGEST_MAX).map((x) => ({ lob_cg: x.lob_cg, score: x.score }));
}

// -> {lob_cg|null, method|null, score|null, suggestions: [{lob_cg, score}]}. Order: exact, normalized,
// alias, then fuzzy suggestions (never applied).
function matchValue(vendor, value) {
  const db = getDb();
  const labels = lobValues(db);
  const raw = trimStr(value);
  const exact = labels.find((l) => l.value === raw);
  if (exact) return { lob_cg: exact.value, method: 'exact', score: 1, suggestions: [] };
  const norm = normalizeOrg(raw);
  const nm = norm ? labels.find((l) => normalizeOrg(l.value) === norm) : null;
  if (nm) return { lob_cg: nm.value, method: 'normalized', score: 1, suggestions: [] };
  const al = norm ? db.prepare('SELECT lob_cg FROM vendor_org_aliases WHERE alias = ?').get(norm) : null;
  if (al) return { lob_cg: al.lob_cg, method: 'alias', score: 1, suggestions: [] };
  return { lob_cg: null, method: null, score: null, suggestions: suggestionsFor(norm, labels) };
}

// ---- ingest --------------------------------------------------------------------------------

function isoOf(now) {
  if (now instanceof Date) return now.toISOString();
  return now ? String(now) : nowIso();
}

function recountPeople(db, vendor) {
  db.prepare(
    `UPDATE vendor_org_values SET people_count = (
       SELECT count(DISTINCT person_key) FROM vendor_org_people p WHERE p.vendor = vendor_org_values.vendor AND p.value = vendor_org_values.value)
     WHERE vendor = ?`
  ).run(vendor);
}

// Re-run matchValue for one stored row when its mapping is not a kept one (alias, confirmed, manual).
function reevaluate(db, row) {
  const kept = row.match_method === 'alias' || row.match_method === 'fuzzy_confirmed' || row.match_method === 'manual';
  if (kept) return false;
  const m = matchValue(row.vendor, row.value);
  if (m.lob_cg === row.lob_cg && m.method === row.match_method) return false;
  db.prepare('UPDATE vendor_org_values SET lob_cg = ?, match_method = ?, score = ?, confirmed_by = NULL, confirmed_at = NULL WHERE id = ?')
    .run(m.lob_cg, m.method, m.score, row.id);
  return true;
}

// orgs = {values: [{value, people: [{person_key, email, display_name}]}]}
function ingest(vendor, orgs, now) {
  const db = getDb();
  const at = isoOf(now);
  const values = (orgs && Array.isArray(orgs.values)) ? orgs.values : [];
  const v = String(vendor);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vendor_org_people WHERE vendor = ?').run(v);
    const insPerson = db.prepare(
      'INSERT OR REPLACE INTO vendor_org_people (vendor, person_key, email, display_name, value, seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const upsert = db.prepare(
      `INSERT INTO vendor_org_values (vendor, value, normalized, first_seen_at, last_seen_at, people_count) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(vendor, value) DO UPDATE SET normalized = excluded.normalized, last_seen_at = excluded.last_seen_at`
    );
    for (const o of values) {
      const value = trimStr(o && o.value);
      if (!value) continue;
      upsert.run(v, value, normalizeOrg(value), at, at);
      for (const p of (o.people || [])) {
        const email = emailNorm(p && p.email);
        const key = keyRaw(p && p.person_key) || email;
        if (!key) continue;
        insPerson.run(v, key, email, trimStr(p.display_name), value, at);
      }
    }
    recountPeople(db, v);
    for (const row of db.prepare('SELECT * FROM vendor_org_values WHERE vendor = ?').all(v)) reevaluate(db, row);
  });
  tx();
  return { values: values.length };
}

// ---- apply to a dataset --------------------------------------------------------------------

// Creates vendor-origin people rows for usage keys with no people row that sit in a mapped vendor
// org. Extract rows are never touched. No-op when the vendor tables are empty.
function applyToDataset(datasetId) {
  const db = getDb();
  const any = db.prepare('SELECT 1 FROM vendor_org_people LIMIT 1').get();
  if (!any) return { created: 0, usage_rows: 0 };
  const sortOf = new Map(lobValuesFor(db, datasetId).map((l) => [l.value, l.sort]));
  const cands = db.prepare(
    `SELECT vp.person_key, vp.email, vp.display_name, v.lob_cg FROM vendor_org_people vp
       JOIN vendor_org_values v ON v.vendor = vp.vendor AND v.value = vp.value
     WHERE v.lob_cg IS NOT NULL
       AND vp.person_key IN (SELECT DISTINCT person_key FROM usage WHERE dataset_id = @ds)
       AND NOT EXISTS (SELECT 1 FROM people p WHERE p.dataset_id = @ds AND p.person_key = vp.person_key)
     ORDER BY vp.vendor, vp.value`
  ).all({ ds: datasetId });
  const pick = new Map();
  for (const c of cands) {
    const s = sortOf.has(c.lob_cg) ? sortOf.get(c.lob_cg) : 999;
    const cur = pick.get(c.person_key);
    if (!cur || s < cur.sort || (s === cur.sort && c.lob_cg < cur.lob_cg)) {
      pick.set(c.person_key, { ...c, sort: s });
    }
  }
  let usageRows = 0;
  const tx = db.transaction(() => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO people (dataset_id, person_key, email, user_id, display_name, u_lob_2, job_function, lob_cg,
         lob_cg_sort, office_code, region, sbl, person_type, extract_as_of, origin)
       VALUES (?, ?, ?, '', ?, '', '', ?, ?, '', 'Unknown', 'Unknown', 'Unknown', NULL, 'vendor')`
    );
    const upd = db.prepare('UPDATE usage SET matched = 1 WHERE dataset_id = ? AND person_key = ?');
    for (const p of pick.values()) {
      ins.run(datasetId, p.person_key, p.email || '', p.display_name || '', p.lob_cg, p.sort);
      usageRows += upd.run(datasetId, p.person_key).changes;
    }
  });
  tx();
  return { created: pick.size, usage_rows: usageRows };
}

// ---- listing -------------------------------------------------------------------------------

function userName(db, id) {
  if (!id) return null;
  const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  return u ? { id: u.id, username: u.username } : { id, username: null };
}

// People with usage in the active dataset but no people row, named by a vendor group, with no mapped value.
function peopleUnmatched(db, vendor) {
  const ds = activeId(db);
  if (!ds) return 0;
  const args = [ds, ds];
  let vf = '';
  if (vendor) { vf = ' AND vp.vendor = ?'; args.push(vendor); }
  return db.prepare(
    `SELECT count(DISTINCT vp.person_key) AS n FROM vendor_org_people vp
     WHERE vp.person_key IN (SELECT DISTINCT person_key FROM usage WHERE dataset_id = ?)
       AND NOT EXISTS (SELECT 1 FROM people p WHERE p.dataset_id = ? AND p.person_key = vp.person_key)${vf}
       AND NOT EXISTS (SELECT 1 FROM vendor_org_people vp2 JOIN vendor_org_values v2 ON v2.vendor = vp2.vendor AND v2.value = vp2.value
         WHERE vp2.person_key = vp.person_key AND v2.lob_cg IS NOT NULL)`
  ).get(...args).n;
}

function counts(db, vendor) {
  const w = vendor ? 'vendor = ? AND ' : '';
  const a = vendor ? [vendor] : [];
  const mapped = db.prepare(`SELECT count(*) AS n FROM vendor_org_values WHERE ${w}lob_cg IS NOT NULL`).get(...a).n;
  const unmatched = db.prepare(`SELECT count(*) AS n FROM vendor_org_values WHERE ${w}lob_cg IS NULL`).get(...a).n;
  return { mapped, unmatched, people_unmatched: peopleUnmatched(db, vendor) };
}

function shapeRow(db, r, labels) {
  return {
    id: r.id, vendor: r.vendor, value: r.value, normalized: r.normalized, lob_cg: r.lob_cg,
    match_method: r.match_method, score: r.score, people_count: r.people_count,
    suggestions: r.lob_cg ? [] : suggestionsFor(r.normalized, labels),
    confirmed_by: userName(db, r.confirmed_by), last_seen_at: r.last_seen_at,
  };
}

function listValues(vendor) {
  const db = getDb();
  const labels = lobValues(db);
  const rows = (vendor
    ? db.prepare('SELECT * FROM vendor_org_values WHERE vendor = ? ORDER BY (lob_cg IS NOT NULL), people_count DESC, value').all(vendor)
    : db.prepare('SELECT * FROM vendor_org_values ORDER BY vendor, (lob_cg IS NOT NULL), people_count DESC, value').all()
  ).map((r) => shapeRow(db, r, labels));
  const aliases = db.prepare('SELECT id, alias, lob_cg FROM vendor_org_aliases ORDER BY alias').all();
  return { rows, lob_values: labels, aliases, counts: counts(db, vendor) };
}

function getRow(db, id) {
  const r = db.prepare('SELECT * FROM vendor_org_values WHERE id = ?').get(id);
  if (!r) throw notFound('Vendor org value');
  return r;
}

// ---- mutations -----------------------------------------------------------------------------

// -> {row, previous, method}. lobCg null/'' clears to unmapped.
function setMapping(id, lobCg, method, userId) {
  const db = getDb();
  const r = getRow(db, id);
  const labels = lobValues(db);
  if (lobCg === null || lobCg === undefined || lobCg === '') {
    db.prepare('UPDATE vendor_org_values SET lob_cg = NULL, match_method = NULL, score = NULL, confirmed_by = NULL, confirmed_at = NULL WHERE id = ?').run(id);
    return { row: shapeRow(db, getRow(db, id), labels), previous: r.lob_cg, method: null };
  }
  const label = trimStr(lobCg);
  if (!labels.some((l) => l.value === label)) throw badRequest(`"${label}" is not a LOB-CG value in the active dataset`);
  if (method !== undefined && method !== null && method !== 'fuzzy_confirmed' && method !== 'manual') {
    throw badRequest("method must be 'fuzzy_confirmed' or 'manual'");
  }
  const m = method || 'manual';
  let score = null;
  if (m === 'fuzzy_confirmed') {
    const s = suggestionsFor(r.normalized, labels).find((x) => x.lob_cg === label);
    score = s ? s.score : null;
  }
  db.prepare('UPDATE vendor_org_values SET lob_cg = ?, match_method = ?, score = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?')
    .run(label, m, score, userId || null, nowIso(), id);
  return { row: shapeRow(db, getRow(db, id), labels), previous: r.lob_cg, method: m };
}

function addAlias(alias, lobCg, userId) {
  const db = getDb();
  const norm = normalizeOrg(alias);
  if (!norm) throw badRequest('alias is required');
  const label = trimStr(lobCg);
  if (!lobValues(db).some((l) => l.value === label)) throw badRequest(`"${label}" is not a LOB-CG value in the active dataset`);
  if (db.prepare('SELECT 1 FROM vendor_org_aliases WHERE alias = ?').get(norm)) throw conflict(`An alias for "${norm}" already exists`);
  const info = db.prepare('INSERT INTO vendor_org_aliases (alias, lob_cg, created_by, created_at) VALUES (?, ?, ?, ?)').run(norm, label, userId || null, nowIso());
  return db.prepare('SELECT id, alias, lob_cg FROM vendor_org_aliases WHERE id = ?').get(info.lastInsertRowid);
}

function removeAlias(id) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM vendor_org_aliases WHERE id = ?').get(id);
  if (!a) throw notFound('Alias');
  db.transaction(() => {
    db.prepare('DELETE FROM vendor_org_aliases WHERE id = ?').run(id);
    db.prepare(
      "UPDATE vendor_org_values SET lob_cg = NULL, match_method = NULL, score = NULL WHERE match_method = 'alias' AND normalized = ?"
    ).run(a.alias);
  })();
  return a;
}

function peopleFor(id) {
  const db = getDb();
  const r = getRow(db, id);
  const ds = activeId(db);
  const rows = db.prepare('SELECT person_key, email, display_name FROM vendor_org_people WHERE vendor = ? AND value = ? ORDER BY display_name, person_key').all(r.vendor, r.value);
  const find = ds ? db.prepare('SELECT lob_cg, origin FROM people WHERE dataset_id = ? AND person_key = ?') : null;
  return {
    rows: rows.map((p) => {
      const e = find ? find.get(ds, p.person_key) : null;
      const inExtract = !!(e && e.origin !== 'vendor');
      return {
        person_key: p.person_key, email: p.email || '', display_name: p.display_name || '',
        in_extract: inExtract, extract_lob_cg: inExtract ? e.lob_cg : null,
      };
    }),
  };
}

// Re-run matching on unmapped rows (and exact / normalized ones), apply to the active dataset and
// rebuild rollups when people were added (usage.matched changes platform and org rollups).
function applyNow() {
  const db = getDb();
  let changed = 0;
  db.transaction(() => {
    for (const row of db.prepare('SELECT * FROM vendor_org_values').all()) if (reevaluate(db, row)) changed += 1;
  })();
  const ds = activeId(db);
  let res = { created: 0, usage_rows: 0 };
  if (ds) {
    res = applyToDataset(ds);
    if (res.created) require('./rollups').build(db, ds);
  }
  return { ...counts(db, null), re_matched: changed, people_created: res.created, usage_rows_matched: res.usage_rows };
}

function exportCsv(vendor) {
  const db = getDb();
  const { toCsv } = require('./csvExport');
  const rows = (vendor
    ? db.prepare('SELECT * FROM vendor_org_values WHERE vendor = ? ORDER BY value').all(vendor)
    : db.prepare('SELECT * FROM vendor_org_values ORDER BY vendor, value').all()
  ).map((r) => {
    const u = userName(db, r.confirmed_by);
    return {
      vendor: r.vendor, value: r.value, normalized: r.normalized, lob_cg: r.lob_cg, match_method: r.match_method,
      score: r.score, people_count: r.people_count, confirmed_by: u ? u.username : null, confirmed_at: r.confirmed_at,
      last_seen_at: r.last_seen_at,
    };
  });
  const columns = ['vendor', 'value', 'normalized', 'lob_cg', 'match_method', 'score', 'people_count', 'confirmed_by', 'confirmed_at', 'last_seen_at'];
  return toCsv(columns, rows);
}

module.exports = {
  normalizeOrg, tokenSetRatio, jaroWinkler, matchValue, ingest, applyToDataset, listValues, setMapping,
  addAlias, removeAlias, peopleFor, applyNow, exportCsv, lobValues,
};
