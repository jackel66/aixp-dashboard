'use strict';
// Deterministic fixture generator (CONTRACT section 7). Same options -> identical output.
// Randomness is keyed by (seed, person, platform, day), so a shorter run that ends on the same
// date reproduces the overlapping months exactly. That is what makes the "previous" baseline work.
const { PLATFORMS } = require('../platforms');
const { LOBCG_SEED } = require('../defaults');
const { addDays, diffDays, todayPhoenix } = require('./time');

const DEFECT_KEYS = [
  'stalePlatform', 'duplicates', 'unmatchedKeys', 'splitLob', 'blankLob', 'emailConflict',
  'regionUnmatched', 'unitSwap', 'seatRepeat', 'nbspKeys', 'truncatedLobLabel',
];

const NBSP = '\u00a0';
const TRUNC_LABEL = 'GBS Data Analytics Rotations and Trainin';
const SPLIT_PAIR = { job_function: 'Compliance Operations', u_lob_2: 'Legal and Compliance', lob_cg: 'GBS - L&C', lob_cg_sort: 9 };

const OFFICES = [
  ['PHX', 'Americas'], ['NYC', 'Americas'], ['DAL', 'Americas'], ['ATL', 'Americas'],
  ['CHI', 'Americas'], ['BOS', 'Americas'], ['SEA', 'Americas'], ['TOR', 'Americas'],
  ['LON', 'EMEA'], ['FRA', 'EMEA'], ['SIN', 'APAC'], ['SYD', 'APAC'],
];
const SBLS = ['North Americas Org', 'Platform Engineering', 'Client Services', 'Corporate Functions',
  'Investment Group', 'Enterprise Risk', 'Shared Services', 'Data and Analytics'];
const FIRST = ['Alex', 'Blake', 'Casey', 'Dana', 'Eli', 'Fran', 'Gray', 'Hollis', 'Iris', 'Jules', 'Kai', 'Lena',
  'Milo', 'Nora', 'Owen', 'Piper', 'Quinn', 'Rhea', 'Sam', 'Tessa', 'Uma', 'Vic', 'Wren', 'Xavi', 'Yara', 'Zane',
  'Aria', 'Beck', 'Cleo', 'Dion', 'Elena', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonah', 'Kira', 'Liam', 'Maya',
  'Noel', 'Opal', 'Pablo', 'Rosa', 'Seth', 'Tara', 'Ulrich', 'Vera', 'Walt', 'Yusuf', 'Zoe'];
const LAST = ['Abbott', 'Baker', 'Chavez', 'Dawson', 'Ellis', 'Foster', 'Garcia', 'Hughes', 'Ibarra', 'Jensen',
  'Keller', 'Lopez', 'Mercer', 'Nolan', 'Ortiz', 'Patel', 'Quincy', 'Reyes', 'Singh', 'Turner', 'Upton', 'Vargas',
  'Walsh', 'Xu', 'Young', 'Zimmer', 'Adler', 'Brooks', 'Cohen', 'Diaz', 'Evans', 'Fischer', 'Grant', 'Hayes',
  'Iyer', 'Jordan', 'Khan', 'Larson', 'Moreno', 'Nguyen', 'Osei', 'Pratt', 'Rowe', 'Sato', 'Tran', 'Usman',
  'Voss', 'Wong', 'Yates', 'Zhou', 'Archer', 'Bishop', 'Crane', 'Dunn', 'Estes', 'Flynn', 'Gomez', 'Harper'];

const MODELS = {
  anthropic: [
    { name: 'claude-sonnet-4-5', rate: 6e-6, weight: 1.0 },
    { name: 'claude-opus-4-1', rate: 3e-5, weight: 0.35 },
    { name: 'claude-haiku-4-5', rate: 2e-6, weight: 1.6 },
  ],
  openai: [
    { name: 'gpt-5', rate: 5e-6, weight: 1.0 },
    { name: 'gpt-5-mini', rate: 1e-6, weight: 1.5 },
    { name: 'o3', rate: 1.5e-5, weight: 0.5 },
  ],
};
const SWAP_MODEL = 'o3';

const SEAT = {
  anthropic: { rate: 40, frac: 0.3 },
  openai: { rate: 30, frac: 0.4 },
  github: { rate: 19, frac: 0.85 },
  cowork: { rate: 30, frac: 0.5 },
};
const GH_UNIT = 0.04;
const WEEKDAY_FACTOR = { 1: 1.1, 2: 1.2, 3: 1.2, 4: 1.1, 5: 0.7 };
const PNAME = {};
for (const p of PLATFORMS) PNAME[p.id] = p.name;

// ---- PRNG --------------------------------------------------------------------------------

function hash(...nums) {
  let h = 0x811c9dc5;
  for (const v of nums) {
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rngFor = (...k) => mulberry32(hash(...k));
function normal(r) {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
const round = (v, d) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// ---- calendar ----------------------------------------------------------------------------

function monthShift(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const EPOCH = '1970-01-01';
const dayIdx = (d) => diffDays(EPOCH, d);
function weekday(d) {
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay();
}
function monthsList(startYm, endYm) {
  const out = [];
  let m = startYm;
  while (m <= endYm) { out.push(m); m = monthShift(m, 1); }
  return out;
}

// ---- main --------------------------------------------------------------------------------

function pickIdx(seed, salt, n, count, avoid) {
  const out = [];
  const set = new Set();
  for (let j = 0; out.length < Math.min(count, n) && j < count * 50 + 50; j++) {
    const i = hash(seed, salt, j) % n;
    if (set.has(i) || (avoid && avoid(i))) continue;
    set.add(i);
    out.push(i);
  }
  return out;
}

function resolveDefects(profile, defects) {
  const base = {};
  for (const k of DEFECT_KEYS) base[k] = profile === 'defective';
  if (defects && typeof defects === 'object') {
    for (const k of DEFECT_KEYS) if (k in defects) base[k] = !!defects[k];
  }
  return base;
}

function generate(opts = {}) {
  const seed = opts.seed === undefined ? 20261103 : opts.seed | 0;
  const months = Math.max(1, opts.months === undefined ? 12 : opts.months | 0);
  const n = Math.max(1, opts.people === undefined ? 400 : opts.people | 0);
  const profile = opts.profile === 'defective' ? 'defective' : 'clean';
  const endDate = opts.endDate || addDays(todayPhoenix(), -2);
  const exportDate = addDays(endDate, 2);
  const defects = resolveDefects(profile, opts.defects);

  const endYm = endDate.slice(0, 7);
  const startYm = monthShift(endYm, -(months - 1));
  const startDate = `${startYm}-01`;
  const allMonths = monthsList(startYm, endYm);

  // Base LOB map pairs; the split pair is added only when that defect is on.
  const lobRows = LOBCG_SEED.map((r) => ({ ...r }));
  if (defects.splitLob) lobRows.push({ ...SPLIT_PAIR });
  const normalPairs = LOBCG_SEED.filter((r) => r.u_lob_2 !== TRUNC_LABEL);
  const pairWeights = normalPairs.map((r) => (r.lob_cg === 'Technology' ? 3 : r.lob_cg === 'EDO' ? 2 : 1.4));
  const weightSum = pairWeights.reduce((a, b) => a + b, 0);

  const ghostCount = defects.unmatchedKeys ? 15 : 0;
  const total = n + ghostCount;

  // ---- persons ----
  const usedKeys = new Set();
  const usedEmails = new Set();
  const persons = [];
  for (let i = 0; i < total; i++) {
    const ghost = i >= n;
    const r = rngFor(seed, 1, i);
    const first = FIRST[Math.floor(r() * FIRST.length)];
    const last = LAST[Math.floor(r() * LAST.length)];
    const numbered = r() < 0.06;
    const num = 10 + Math.floor(r() * 90);
    let key = (first[0] + last).toLowerCase().replace(/[^a-z]/g, '');
    if (ghost) key = `ctr${key}`;
    if (numbered) key += num;
    let tries = 2;
    const baseKey = key;
    while (usedKeys.has(key)) { key = `${baseKey}${tries}`; tries += 1; }
    usedKeys.add(key);
    let email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
    const baseEmail = email;
    tries = 2;
    while (usedEmails.has(email)) { email = `${baseEmail}${tries}`; tries += 1; }
    usedEmails.add(email);
    email += '@corp.example';

    let pw = r() * weightSum;
    let pair = normalPairs[normalPairs.length - 1];
    for (let j = 0; j < normalPairs.length; j++) {
      pw -= pairWeights[j];
      if (pw <= 0) { pair = normalPairs[j]; break; }
    }
    const office = OFFICES[Math.floor(r() * OFFICES.length)][0];
    const pType = r() < 0.85 ? 'Employee' : ['Contractor', 'Intern', 'Vendor'][Math.floor(r() * 3)];
    const sbl = SBLS[Math.floor(r() * SBLS.length)];
    const baseP = 0.25 + r() * 0.2;
    const heavy = 0.5 + r() * r() * 3;
    const adopt = { anthropic: r() < 0.7, openai: r() < 0.55, github: r() < 0.85, cowork: r() < 0.5 };
    const modelMask = { anthropic: 1 + Math.floor(r() * 7), openai: 1 + Math.floor(r() * 7) };
    if (!adopt.anthropic && !adopt.openai && !adopt.github && !adopt.cowork) adopt.github = true;
    persons.push({
      i, ghost, key, email, first, last, display: `${first} ${last}`,
      userId: `U${2000000 + i}`,
      jf: pair.job_function, lob: pair.u_lob_2, office, pType, sbl, baseP, heavy, adopt, modelMask,
      ghScale: 0.6 + r() * 1.8, ghDisc: r() * 0.15, cwScale: 0.5 + r() * 2.5,
      variant: false, oldRow: false,
    });
  }
  const real = persons.slice(0, n);

  // Old extract rows (stale attributes) for about 6 percent of people.
  for (const p of real) p.oldRow = rngFor(seed, 2, p.i)() < 0.06;

  // ---- defect assignment ----
  const seatSet = new Set();
  if (defects.truncatedLobLabel) {
    for (const i of pickIdx(seed, 101, n, 10)) { real[i].jf = 'Data Analytics'; real[i].lob = TRUNC_LABEL; }
  }
  if (defects.splitLob) {
    for (const i of pickIdx(seed, 102, n, Math.max(3, Math.round(n * 0.03)))) {
      real[i].jf = SPLIT_PAIR.job_function; real[i].lob = SPLIT_PAIR.u_lob_2;
    }
  }
  if (defects.blankLob) {
    for (const i of pickIdx(seed, 103, n, 12)) { real[i].lob = ''; real[i].oldRow = true; real[i].oldKeepsLob = true; }
  }
  if (defects.regionUnmatched) {
    for (const i of pickIdx(seed, 104, n, 4)) real[i].office = 'ZZ9';
  }
  if (defects.nbspKeys) {
    for (const i of pickIdx(seed, 105, n, 8)) { real[i].variant = true; real[i].oldRow = true; }
  }
  if (defects.emailConflict && n >= 2) {
    const [a, b] = pickIdx(seed, 106, n, 2);
    real[b].email = real[a].email;
  }
  const seatMonth = allMonths.length >= 2 ? monthShift(endYm, -1) : null;
  if (defects.seatRepeat && seatMonth) {
    for (const i of pickIdx(seed, 107, n, 3, (x) => !real[x].adopt.github)) seatSet.add(i);
  }

  // ---- usage ----
  const variantKey = (p) => p.key[0].toUpperCase() + p.key.slice(1) + NBSP;
  const days = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const wd = weekday(d);
    if (wd >= 1 && wd <= 5) days.push({ d, wd, idx: dayIdx(d), ym: d.slice(0, 7) });
  }
  const staleCut = defects.stalePlatform ? addDays(endDate, -9) : null;

  const rows = [];
  const anthropicRows = [];
  const perPlatformAsOf = {};
  const note = (pid, d) => { if (!perPlatformAsOf[pid] || d > perPlatformAsOf[pid]) perPlatformAsOf[pid] = d; };

  function tokenRow(pid, p, d, model, tokens, cost, extra) {
    const swapped = defects.unitSwap && pid === 'openai' && model.name === SWAP_MODEL;
    const tk = tokens === '' ? '' : swapped ? Math.max(1, Math.round(tokens / 100)) : tokens;
    const useVariant = p.variant && rngFor(seed, 60, p.i, dayIdx(d))() < 0.5;
    const row = {
      Date: d,
      PersonKey: useVariant ? variantKey(p) : p.key,
      Platform: PNAME[pid],
      Model: model.name,
      Tokens: tk,
      Credits: extra.credits === undefined ? '' : extra.credits,
      Consumption: tk === '' ? 0 : tk,
      ConsumptionUnit: 'tokens',
      CostUSD: cost,
      requests: extra.requests === undefined ? '' : extra.requests,
      discount_amount: '',
      net_amount: '',
      email: pid === 'anthropic' ? p.email : '',
    };
    rows.push(row);
    if (pid === 'anthropic') anthropicRows.push(row);
    note(pid, d);
  }

  for (const p of persons) {
    for (const dd of days) {
      const d = dd.d;
      const wf = WEEKDAY_FACTOR[dd.wd];

      // Anthropic and OpenAI (token platforms).
      for (const pid of ['anthropic', 'openai']) {
        if (!p.adopt[pid]) continue;
        const r = rngFor(seed, pid === 'anthropic' ? 10 : 20, p.i, dd.idx);
        if (r() >= p.baseP * wf * (pid === 'anthropic' ? 1.05 : 0.9)) continue;
        const list = MODELS[pid];
        let emitted = 0;
        for (let m = 0; m < list.length; m++) {
          if (!(p.modelMask[pid] & (1 << m))) continue;
          const keep = r() < 0.75;
          const z = normal(r);
          const noise = 0.9 + 0.2 * r();
          const kind = r();
          const lastModel = m === list.length - 1;
          if (!keep && !(lastModel && emitted === 0)) continue;
          emitted += 1;
          const tokens = Math.max(1000, Math.round(Math.exp(Math.log(110000 * p.heavy * list[m].weight) + 0.8 * z)));
          let cost = round(tokens * list[m].rate * noise, 6);
          let tk = tokens;
          let credits;
          if (pid === 'openai') {
            if (kind < 0.02) tk = ''; // count-priced row: cost, no tokens
            else if (kind < 0.03) cost = ''; // token row with no billing value
            credits = cost === '' ? '' : round(cost * 20, 2);
          }
          tokenRow(pid, p, d, list[m], tk, cost, {
            credits,
            requests: pid === 'anthropic' ? Math.max(1, Math.round(tokens / (4000 + 8000 * r()))) : undefined,
          });
        }
      }

      // GitHub Copilot.
      if (p.adopt.github && (!staleCut || d <= staleCut)) {
        const isSeat = seatSet.has(p.i) && dd.ym === seatMonth;
        const r = rngFor(seed, 30, p.i, dd.idx);
        if (isSeat) {
          const rate = SEAT.github.rate;
          rows.push({
            Date: d, PersonKey: `${p.key}_capgroup`, Platform: PNAME.github, Model: '',
            Tokens: '', Credits: Math.round(rate / GH_UNIT), Consumption: Math.round(rate / GH_UNIT),
            ConsumptionUnit: 'credits', CostUSD: rate, requests: '', discount_amount: 0, net_amount: rate, email: '',
          });
          note('github', d);
        } else if (!seatSet.has(p.i) || dd.ym !== seatMonth) {
          if (r() < p.baseP * wf * 1.1) {
            const q = Math.max(1, Math.round(p.ghScale * (30 + 150 * r() * r())));
            const gross = round(q * GH_UNIT, 4);
            const disc = round(gross * p.ghDisc, 4);
            rows.push({
              Date: d, PersonKey: `${p.key}_capgroup`, Platform: PNAME.github, Model: '',
              Tokens: '', Credits: q, Consumption: q, ConsumptionUnit: 'credits',
              CostUSD: gross, requests: '', discount_amount: disc, net_amount: round(gross - disc, 4), email: '',
            });
            note('github', d);
          }
        }
      }
    }

    // Copilot Cowork: cumulative "Monthly credits used" snapshots per person + month.
    if (p.adopt.cowork) {
      let curYm = null;
      let cum = 0;
      let lastDate = null;
      const closeMonth = () => {
        if (curYm === null || lastDate === null) return;
        const r = rngFor(seed, 41, p.i, hash(+curYm.slice(0, 4), +curYm.slice(5, 7)));
        if (r() >= 0.04) return;
        let nd = addDays(lastDate, 1);
        while (weekday(nd) === 0 || weekday(nd) === 6) nd = addDays(nd, 1);
        if (nd.slice(0, 7) !== curYm || nd > endDate) return;
        const bump = Math.max(1, Math.round(p.cwScale * (10 + 40 * r())));
        pushCowork(nd, cum + bump);
      };
      const pushCowork = (d, credits) => {
        rows.push({
          Date: d, PersonKey: p.key, Platform: PNAME.cowork, Model: '', Tokens: '', Credits: credits,
          Consumption: credits, ConsumptionUnit: 'credits', CostUSD: '', requests: '', discount_amount: '',
          net_amount: '', email: p.email,
        });
        note('cowork', d);
      };
      for (const dd of days) {
        if (dd.ym !== curYm) { closeMonth(); curYm = dd.ym; cum = 0; lastDate = null; }
        const r = rngFor(seed, 40, p.i, dd.idx);
        if (r() >= p.baseP * WEEKDAY_FACTOR[dd.wd] * 0.9) continue;
        cum += Math.max(1, Math.round(p.cwScale * (20 + 200 * r())));
        lastDate = dd.d;
        pushCowork(dd.d, cum);
      }
      closeMonth();
    }
  }

  // Blank-key rows (nbspKeys): keys that are empty or only non-breaking spaces.
  if (defects.nbspKeys && anthropicRows.length) {
    const blanks = ['', NBSP, '  ', NBSP + NBSP, ' '];
    for (let b = 0; b < blanks.length; b++) {
      const src = anthropicRows[Math.min(anthropicRows.length - 1, b * 37)];
      rows.push({ ...src, PersonKey: blanks[b], email: '', Tokens: 1000, Consumption: 1000, CostUSD: 0.002, requests: 1 });
    }
  }

  // Stable date order, then repeat 200 Anthropic rows right after their originals.
  const order = rows.map((r, idx) => [r, idx]);
  order.sort((x, y) => (x[0].Date < y[0].Date ? -1 : x[0].Date > y[0].Date ? 1 : x[1] - y[1]));
  const dupSet = new Set();
  if (defects.duplicates && anthropicRows.length) {
    const want = Math.min(200, anthropicRows.length);
    const stride = Math.max(1, Math.floor(anthropicRows.length / want));
    for (let k = 0; k < want; k++) dupSet.add(anthropicRows[(k * stride + 3) % anthropicRows.length]);
  }
  const usage = [];
  for (const [row] of order) {
    usage.push(row);
    if (dupSet.has(row)) usage.push({ ...row });
  }

  // ---- people rows ----
  const exportOld = addDays(exportDate, -35);
  const people = [];
  for (const p of real) {
    const lob = p.lob;
    people.push({
      PersonKey: p.variant ? variantKey(p) : p.key, email: p.email, 'User ID': p.userId, DisplayName: p.display,
      u_lob_2: lob, job_function: p.jf, OfficeCode: p.office, u_bo_fier_sbl: p.sbl,
      u_cg_person_type_code: p.pType, ExtractAsOf: exportDate,
    });
    if (p.oldRow) {
      const lobOld = p.oldKeepsLob ? LOBCG_SEED.find((r) => r.job_function === p.jf) : null;
      people.push({
        PersonKey: p.key, email: p.email, 'User ID': p.userId, DisplayName: p.display,
        u_lob_2: p.oldKeepsLob ? (lobOld ? lobOld.u_lob_2 : 'Operations') : lob, job_function: p.jf,
        OfficeCode: p.office, u_bo_fier_sbl: `${p.sbl} (prior)`, u_cg_person_type_code: p.pType,
        ExtractAsOf: exportOld,
      });
    }
  }

  // ---- seat rates, region map, LOB map ----
  const seatRate = [];
  for (const pl of PLATFORMS) {
    allMonths.forEach((ym, mi) => {
      const grow = allMonths.length > 1 ? 0.9 + (0.1 * mi) / (allMonths.length - 1) : 1;
      seatRate.push({
        Platform: pl.name, Month: ym, RateUSD: SEAT[pl.id].rate,
        LicensedSeats: Math.max(1, Math.round(n * SEAT[pl.id].frac * grow)),
      });
    });
  }
  const regionMap = OFFICES.map(([c, r]) => ({ OfficeCode: c, Region: r }));
  const lobCgMap = lobRows.map((r) => ({
    job_function: r.job_function, u_lob_2: r.u_lob_2, 'LOB-CG': r.lob_cg, 'LOB-CG Sort': r.lob_cg_sort,
  }));

  return {
    usage, people, seatRate, regionMap, lobCgMap,
    meta: {
      exportDate, endDate, startDate, seed, months, people: n, profile, perPlatformAsOf,
      defects, ghosts: ghostCount, seatMonth: defects.seatRepeat ? seatMonth : null,
    },
  };
}

module.exports = { generate, DEFECT_KEYS, TRUNC_LABEL, SPLIT_PAIR, mulberry32, hash };
