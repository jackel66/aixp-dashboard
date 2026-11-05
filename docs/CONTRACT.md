# AIxP Dashboard - build contract

Owner: Fable (orchestration and QA). Builders: four Sonnet agents (A, B, C, D), one
checkout, file ownership in section 10. Every rule here is binding; where this file and a
builder's own idea disagree, this file wins. Read ProjectPrimer (project root) before
touching data shapes or check logic; it is the only source of truth for column names,
units and verification rules.

Project root: D:\VSCode Projects\AIDashbaord
Run target: pm2 app aixp-dashboard, backend port 3090, frontend served by the backend
from frontend/dist. Vite dev server 5190 proxies /api to 3090.

House rules, no exceptions:
- ASCII only in every file: no em dashes, curly quotes, emoji or arrows in code,
  comments, UI copy or docs. Use "-" and plain quotes. Headings in sentence case. No
  bold mid-sentence in UI copy.
- Never kill node processes by name; kill by pid only. Never touch pm2 apps.
- Do not create files outside your ownership list. Do not delete files you did not
  create. Zero-byte spill files (from shell redirects inside js expressions) are a
  defect: never commit them.
- Every builder reports verbatim test output, not a summary, when done.
- Builders C and D run Skill("dataviz") before writing any chart, stat tile, sparkline
  or palette code and take hex values from its references/palette.md.

## 1. What the app is

An executive web view of AI platform economics for a COO forum: spend, consumption and
active users across four platforms (Anthropic, OpenAI, GitHub Copilot, Copilot Cowork),
with organisational attribution (LOB-CG, Region, SBL, person type), model detail, user
detail and built-in data verification. It replaces a thin Power BI report with five
pages (Read Me, Overview, Organization, Models, Users).

v1 runs on FIXTURE data only: a deterministic generator shaped to the model contract.
No file import exists in v1. The schema keeps a staging and promote seam so an importer
can be added later without touching pages (section 5, deferred importer).

Standing caveat, shown verbatim in the landing footer and as the first line of every
CSV export (constant CAVEAT in backend/src/platforms.js):

"This dashboard provides a directional view of AI spend. It may not reconcile to actual
invoices or Finance-reported expense and should not be used for budget reconciliation."

## 2. Column contract (from the primer)

Platform ids and display names (PLATFORMS registry in backend/src/platforms.js; the
frontend mirrors it in src/lib/platforms.js):

| id | name | unit | models | notes |
|---|---|---|---|---|
| anthropic | Anthropic | tokens | yes | requests kept; cost from amount_usd |
| openai | OpenAI | tokens | yes | credits = billing_cost_value kept separately, never substituted for dollars |
| github | GitHub Copilot | credits | no | credits = quantity, cost = gross_amount, discount_amount and net_amount kept |
| cowork | Copilot Cowork | credits | no | raw rows are cumulative monthly snapshots (Monthly credits used); cost = credits x cowork.rate (0.008, reconfirm flag) |

Usage columns (primer names, exact capitalization, used in stage tables and fixture
output): Date, PersonKey, Platform, Model, Tokens, Credits, Consumption,
ConsumptionUnit, CostUSD, requests, discount_amount, net_amount, email.
People columns: PersonKey, email, User ID, DisplayName, u_lob_2, job_function,
OfficeCode, u_bo_fier_sbl, u_cg_person_type_code, ExtractAsOf.
SeatRate: Platform, Month (YYYY-MM), RateUSD, LicensedSeats.
RegionMap: OfficeCode, Region.
LobCgMap: job_function, u_lob_2, LOB-CG, LOB-CG Sort.

Unit rules (binding everywhere, backend and frontend):
- consumption_unit is always set per row (tokens or credits).
- Tokens and credits are never summed across platforms into one number. Only cost_usd
  crosses platforms. Every consumption figure travels as {value, unit}.
- Seat spend lives in seat_rate by month and is never written into usage rows.
- Spend bases: consumption = sum(cost_usd); seat = rate_usd x seats per platform per
  month (seats = licensed_seats, or distinct active people in rollup_person_month when
  spend.seat_basis = active, labelled "estimate"); total = consumption + seat. Every
  spend figure travels as {usd, basis}.
- Active user = distinct nonblank person_key with cost_usd > 0 or tokens > 0 or
  credits > 0 in the range.
- Spend per unit is valid only on token platforms over priced token-bearing rows,
  excluding seat spend; the API carries spend_per_unit.valid and the UI hides the tile
  when false.

LOB-CG mapping rules (seed in defaults.js, editable in Settings): Legal and Compliance
-> "GBS - L&C"; Global Risk Management -> "GBS - GRM"; Workplace Experience -> "GBS -
Workplace Experience"; the truncated label "GBS Data Analytics Rotations and Trainin"
-> "NACG" sort 2; EDO job functions stay "EDO". One sort value per label.

## 3. Database schema (backend/src/db.js, owner A)

One SCHEMA string of CREATE TABLE IF NOT EXISTS statements, WAL, busy_timeout 5000,
hand ALTERs by PRAGMA table_info like the Deal Tracker. Dates are YYYY-MM-DD TEXT,
months YYYY-MM TEXT, money and counts REAL. Settings seeded with INSERT OR IGNORE from
defaults.js. Exports getDb, open, close, dbPath. DB_PATH env overrides
backend/data/aixp.db.

```
datasets(id INTEGER PK, label TEXT, source TEXT, status TEXT, created_at, verified_at,
  promoted_at, archived_at, file_hash TEXT NULL, seed INTEGER NULL, options_json TEXT,
  verdict TEXT NULL, counts_json TEXT, note TEXT)
  -- source fixture|import; status staging|verified|active|archived|failed;
  -- verdict pass|warn|fail; UNIQUE partial index on file_hash WHERE NOT NULL
dataset_platforms(dataset_id, platform, min_date, max_date, export_date, row_count,
  cost_usd, tokens, credits, consumption, PRIMARY KEY(dataset_id, platform))

stage_usage(id PK, dataset_id, row_no, date, person_key, platform, model, tokens,
  credits, consumption, consumption_unit, cost_usd, requests, discount_amount,
  net_amount, email, extra_json)                     -- all TEXT, as given
stage_people(id PK, dataset_id, row_no, person_key, email, user_id, display_name,
  u_lob_2, job_function, office_code, u_bo_fier_sbl, u_cg_person_type_code,
  extract_as_of, extra_json)
stage_seat_rate(dataset_id, row_no, platform, month, rate_usd, licensed_seats)
stage_region_map(dataset_id, row_no, office_code, region)
stage_lob_cg_map(dataset_id, row_no, job_function, u_lob_2, lob_cg, lob_cg_sort)
INDEX ix_stage_usage_ds ON stage_usage(dataset_id)

usage(id PK, dataset_id, date, person_key, platform, model, tokens REAL, credits REAL,
  consumption REAL, consumption_unit TEXT, cost_usd REAL, cost_source TEXT,
  requests INTEGER, discount_amount REAL, net_amount REAL, matched INTEGER,
  snapshot_rank INTEGER)
  -- platform holds the id (anthropic|openai|github|cowork); cost_source vendor|derived|none
INDEX ix_usage_ds_date(dataset_id, date); ix_usage_ds_plat_date(dataset_id, platform, date);
ix_usage_ds_person(dataset_id, person_key, platform);
ix_usage_grain(dataset_id, date, person_key, platform, model)   -- NOT unique on purpose

people(dataset_id, person_key, email, user_id, display_name, u_lob_2, job_function,
  lob_cg, lob_cg_sort, office_code, region, sbl, person_type, extract_as_of,
  PRIMARY KEY(dataset_id, person_key))   -- person_type Associate|Non-Associate|Unknown
seat_rate(dataset_id, platform, month, rate_usd, licensed_seats, PRIMARY KEY(dataset_id, platform, month))
region_map(dataset_id, office_code, region, PRIMARY KEY(dataset_id, office_code))
lob_cg_map(dataset_id, job_function, u_lob_2, lob_cg, lob_cg_sort, PRIMARY KEY(dataset_id, job_function, u_lob_2))

verification_runs(id PK, dataset_id, ran_at, verdict, fail_count, warn_count, info_count,
  pass_count, duration_ms, compared_to_dataset_id NULL)
verification_results(id PK, run_id, check_id, severity, status, platform TEXT NULL,
  title, message, metrics_json, evidence_json, affected INTEGER)
  -- status pass|fail|skip; evidence_json = {columns:[], rows:[<=50], total}
INDEX ix_vr_run(run_id, check_id)

rollup_platform_day(dataset_id, date, platform, rows, cost_usd, tokens, credits,
  consumption, requests, active_users, matched_cost_usd, unmatched_cost_usd,
  PRIMARY KEY(dataset_id, platform, date))
rollup_model_day(dataset_id, date, platform, model, rows, cost_usd, tokens, credits,
  consumption, requests, active_users, PRIMARY KEY(dataset_id, platform, model, date))
rollup_person_day(dataset_id, date, platform, person_key, rows, cost_usd, tokens,
  credits, consumption, requests, PRIMARY KEY(dataset_id, person_key, platform, date))
rollup_org_month(dataset_id, month, platform, lob_cg, lob_cg_sort, region, sbl,
  person_type, matched, rows, cost_usd, tokens, credits, consumption, active_users)
  INDEX(dataset_id, month, platform)
rollup_person_month(dataset_id, month, platform, person_key, cost_usd, tokens, credits,
  consumption, active_days, PRIMARY KEY(dataset_id, person_key, platform, month))
settings(key TEXT PK, value TEXT)
```

A owns the SCHEMA string. B may only INSERT and DELETE in rollup_* and seat_rate /
lob_cg_map (settings edits).

## 4. Settings keys (backend/src/defaults.js, owner A; validators in settings.js VALIDATORS, owner B)

| key | default | meaning |
|---|---|---|
| spend.seat_basis | "licensed" | licensed or active |
| spend.default_basis | "consumption" | default basis toggle on pages |
| cowork.rate | 0.008 | USD per Cowork credit |
| cowork.rate_confirmed | false | UI shows "reconfirm" badge while false |
| verify.stale_days | 5 | freshness check threshold |
| verify.gap_days | 2 | coverage gap threshold |
| verify.unmatched_pct | 2 | unmatched cost share threshold (percent) |
| verify.delta_pct | 25 | platform total delta threshold vs previous dataset |
| fixture.options | {"seed":20261103,"months":12,"people":400,"profile":"defective"} | last used generator options |
| datasets.keep | 5 | archived datasets to keep |
| lobcg.seed | the mapping rows from section 2 | used by the fixture and as the editable map default |

## 5. Load path (owner A)

- services/staging.js: createDataset({label, source, seed, options, file_hash}) -> id
  (status staging); loadTables(datasetId, {usage, people, seatRate, regionMap,
  lobCgMap}) takes arrays of plain objects keyed by the primer column names and writes
  stage_* as TEXT in one transaction (prepared inserts, 5000 rows per chunk).
  headerKey(name) strips a "Table[...]" wrapper, trims, lowercases, collapses spaces and
  resolves synonyms (cost_usd, amount_usd -> CostUSD; personkey, person_key, alias ->
  PersonKey; etc.) so the later importer reuses it.
- services/normalize.js normalize(datasetId): PersonKey = lowercase, replace U+00A0
  with space, trim, drop blank (counted in counts_json.droppedBlankKey) BEFORE any
  grouping; email lowercase and trim; github alias strips a trailing _capgroup; Date
  must parse (YYYY-MM-DD, ISO datetime, or M/D/YYYY), numbers numeric or blank; a row
  failing either is rejected and counted (counts_json.rejected with up to 20 samples),
  never coerced. Platform display names map to ids through PLATFORMS; an unknown
  platform rejects the row. People: one row per key, newest extract_as_of wins (tie:
  the row with u_lob_2, then first); lob_cg and lob_cg_sort from lob_cg_map by
  (job_function, u_lob_2) else "Unassigned" sort 999; region from region_map else
  "Unknown" with office_code kept; person_type Employee -> Associate, other populated
  -> Non-Associate, blank -> Unknown. People with blank u_lob_2 are RETAINED. Cowork:
  per person+month keep the latest snapshot (snapshot_rank 1), dated at the snapshot
  date, cost_usd = credits x cowork.rate, cost_source derived; older snapshots stay in
  stage only. usage.matched = 1 when the key exists in people. consumption = tokens on
  token platforms, credits on credit platforms.
- services/datasets.js: list(), get(id), active(), healthSummary(), verify(id,
  {compareTo}) -> run (stores results, sets verdict and verified_at), promote(id,
  {force}) in ONE transaction: refuse with HttpError 409 when verdict is fail and
  force is not set, archive the current active, call rollups.build(db, id), fill
  dataset_platforms, set status active and promoted_at, then broadcast
  dataset.promoted {id}; rollback(toId) promotes an archived dataset without
  re-verifying; purge() drops stage rows of archived datasets beyond datasets.keep and
  usage rows beyond the newest 2 archived.
- services/fixture.js generate(opts) (section 7). First boot is B's server.js: when no
  active dataset exists, generate a "previous" fixture (same seed, months - 1,
  profile clean) then the current one from fixture.options, each through staging ->
  normalize -> verify -> promote, so delta checks have a baseline. Log one line per
  step.
- Deferred importer (NOT built in v1, documented here only): sniff CSV vs XLSX, stream
  parse, auto-map headers through headerKey plus a saved mapping the UI confirms, hash
  into datasets.file_hash (409 on repeat), then loadTables -> normalize -> verify ->
  promote. Nothing else changes.

## 6. Verification engine (backend/src/services/verify/, owner A)

index.js exports CHECKS (ordered array of {id, title, severity, platformScoped,
meaning}) and run(ctx) where ctx = {db, datasetId, prevDatasetId, settings, today}.
One file per check exporting {id, title, severity, meaning, run(ctx) -> result | result[]}
where result = {status pass|fail|skip, platform id|null, message, metrics {}, evidence
{columns, rows (<= 50), total}, affected}. platformScoped checks return one result per
platform. meaning is one or two primer-derived sentences shown in the UI ("What this
means"). Verdict: any failed fail-severity check -> fail; else any failed warn -> warn;
else pass. info never moves the verdict.

| id | sev | scoped | pass rule |
|---|---|---|---|
| freshness_per_platform | fail | yes | platform max(date) >= overall max(date) - verify.stale_days; the message names the stale platform and says the overall maximum hid it |
| date_coverage_gaps | warn | yes | missing calendar days between platform min and max <= verify.gap_days (weekends count only when the platform has any weekend rows) |
| duplicate_grain_rows | fail | yes | 0 groups at date+person_key+platform+model with count > 1 (evidence: top groups with counts and cost sum) |
| people_key_unique_nonblank | fail | no | 0 stage keys blank after normalization and 0 distinct raw keys collapsing to one normalized key |
| email_key_conflict | fail | no | 0 emails resolving to more than one person_key (stage_people and usage email) |
| unmatched_usage | warn | yes | unmatched cost share <= verify.unmatched_pct; evidence has rows, raw cost, attributed cost, distinct keys |
| blank_lob_retained | info | no | always pass; lists people with blank u_lob_2 and their spend |
| lob_cg_label_split | fail | no | 0 lob_cg labels with more than one distinct sort value (map and people) |
| region_unmatched_office | warn | no | 0 people office codes outside region_map |
| unit_sanity | warn | yes | token platforms: cost per token per model inside [1e-7, 1e-3]; rows with cost and no tokens, and tokens and no cost, are counted in metrics and labelled, not failed; credit platforms skip the rate test |
| cowork_cumulative_snapshots | warn | no | stage Cowork rows per person+month are non-decreasing by date (cumulative confirmed) and normalized usage has exactly one Cowork row per person+month |
| seat_spend_not_in_rows | fail | yes | 0 usage rows whose cost equals the platform's monthly seat rate x seats, or that repeat one identical cost on every day of a month for a person |
| platform_total_delta | warn | yes | abs percent change of cost and rows vs prevDatasetId over overlapping months <= verify.delta_pct; skip when no previous |
| attribution_before_after | info | yes | always pass; rows and cost in stage vs usage, dropped blank keys, rejected rows |
| people_duplicate_lookup_growth | fail | no | people row count equals distinct person_key count after the region and LOB merges |

## 7. Fixture generator (backend/src/services/fixture.js + scripts/gen-fixture.js, owner A)

generate({seed = 20261103, months = 12, people = 400, endDate, profile, defects})
with a mulberry32 PRNG seeded from seed; returns {usage, people, seatRate, regionMap,
lobCgMap, meta: {exportDate, perPlatformAsOf, defects}} in primer column names. Same
seed and options always produce identical output. endDate defaults to today (Phoenix)
minus 2 days (reporting lag). people get realistic display names, aliases as keys
(first initial + surname, a few with numbers), emails, offices across 12 codes, LOB
labels drawn from the map, job functions, person types (85% Employee), SBL labels.
Each person is active on 25 to 45 percent of weekdays with a weekly rhythm; Anthropic
and OpenAI rows carry 1 to 3 models (claude-sonnet-4-5, claude-opus-4-1,
claude-haiku-4-5; gpt-5, gpt-5-mini, o3), tokens and priced cost at realistic
rates; GitHub rows carry quantity credits with gross/discount/net; Cowork rows are
daily cumulative "Monthly credits used" per person+month with one later revision.
SeatRate rows per platform per month; RegionMap for the 12 offices; LobCgMap from
lobcg.seed.

Profiles: clean (every defect off) and defective (every defect on). Defect flags, each
targeting exactly one check: stalePlatform (GitHub ends 9 days before the others),
duplicates (200 Anthropic rows repeated), unmatchedKeys (15 usage keys absent from
People, about 3 percent of spend), splitLob ("GBS - L&C" rows carrying sorts 4 and 9),
blankLob (12 people, info only), emailConflict (one email on two keys),
regionUnmatched (office ZZ9), unitSwap (one OpenAI model at 100x cost per token),
seatRepeat (GitHub rows carrying the monthly seat cost daily), nbspKeys (keys with
U+00A0 and mixed case that collapse after normalization), truncatedLobLabel (the
primer's truncated GBS label present in People). coworkCumulative is always on.
Script: node scripts/gen-fixture.js --out <dir> writes the five CSVs;
--seed-db --profile clean|defective [--seed N --months N --people N] loads,
verifies and promotes into DB_PATH or the default db and prints the verdict.

## 8. API (routes in backend/src/routes/*.js, services reports.js, measures.js, csvExport.js, owner B)

Common query params: dataset (id, default active), from, to (YYYY-MM-DD, default the
90 days ending at the active dataset's overall max date), platform (repeatable id),
basis = consumption | seat | total (default spend.default_basis). Money is
{usd, basis}; consumption is {value, unit}. Unknown platform ids, bad dates and
from > to answer 400. All responses carry asOf (overall max date of the dataset).
Timing budget: every GET below answers in under 200 ms warm on the default fixture.

GET /api/summary ->
```
{ asOf, dataset: {id, label, source, seed, promoted_at, verdict, counts: {usage_rows, people, platforms}},
  range: {from, to},
  headline: { period: {from, to, label: "November 2026 to date"},
              spend: {consumption: {usd}, seat: {usd}, total: {usd}},
              prior: {period: {from, to, label: "October 2026, same days"}, spend: {...}} },
  platforms: [ {id, name, unit, as_of, lag_days, stale, rows, spend: {consumption, seat, total},
                consumption: {value, unit}, active_users, models_supported,
                spark: [{date, usd}] (last 30 days) } ],
  totals: {spend: {consumption, seat, total}, active_users},
  confidence: {verdict, fail, warn, info, pass, run_id, ran_at, first_failing: {id, title} | null},
  caveat }
```
GET /api/trend?grain=day|week|month -> {asOf, grain, from, to, basis, buckets:
[{start, label, platforms: {anthropic: {usd, active_users, consumption: {value, unit}},
...}, total_usd, active_users}]}. Week starts Monday (time.mondayOf).

GET /api/platforms/:id -> {asOf, platform: {id, name, unit, models_supported}, as_of,
lag_days, stale, coverage: {from, to, days, gaps}, spend: {consumption, seat, total},
prior: {spend} (previous window of the same length), consumption: {value, unit},
active_users, spend_per_unit: {valid, usd, unit}, github: {gross, discount, net} | null,
cowork: {rate, confirmed} | null, trend: [{start, usd, consumption: {value, unit},
active_users}] (weekly over the range), models: [{model, usd, consumption, users, share}]
([] when not supported), top_users: [{person_key, display_name, lob_cg, usd,
consumption}] (20), checks: [{id, title, severity, status, message, metrics, affected}]
(results of the latest run scoped to this platform plus unscoped fail results)}

GET /api/organization?dim=lob_cg|region|sbl|person_type&measure=spend|users|units ->
{asOf, dim, measure, basis, rows: [{key, label, sort, cells: {anthropic: {usd,
active_users, consumption: {value, unit}}, ...}, total: {usd, active_users}}],
totals: {cells, total}}. Rows always include key "__unassigned__" (label
"Unassigned") and, last, "__unmatched__" (label "Unmatched usage", from usage rows
with matched = 0). Sorted by sort then total desc; unmatched always last.
GET /api/organization/cell?dim&key&platform -> {contributors: [{person_key,
display_name, usd, consumption}] (5), share_of_row, share_of_column, total}.

GET /api/models -> {asOf, rows: [{platform, model, usd, consumption: {value, unit},
requests, users, share, cost_per_unit}]} (token platforms only; cost_per_unit null
elsewhere). GET /api/models/:platform/:model -> {platform, model, usd, consumption,
requests, users, trend: [{start, usd}] (12 weeks), top_users (10)}.

GET /api/users?q&sort=usd|name|lob_cg|active_days&dir=asc|desc&page&pageSize(<=200,
default 50)&platform&lob_cg&region -> {asOf, rows: [{person_key, display_name, lob_cg,
region, sbl, person_type, matched, usd, platforms: {anthropic: usd, ...},
active_days}], total, page, pageSize}. q matches key, display name and email,
case-insensitive. GET /api/users/:personKey -> {person: {person_key, display_name,
email, user_id, lob_cg, region, sbl, office_code, person_type, matched}, spend: {usd},
platforms: [{id, usd, consumption, active_days}], trend: [{date, usd}] (daily, 90
days), models: [{platform, model, usd, consumption}], activity: [{date, platform,
model, consumption, usd}] (50 newest)}.

GET /api/verification -> {run: {id, dataset_id, ran_at, verdict, fail, warn, info,
pass}, checks: [{id, title, severity, status, platform, message, metrics, meaning,
affected}]} (latest run of the dataset; checks with no run yet come from CHECKS with
status "skip"). GET /api/verification/runs/:runId -> run + checks with evidence.
GET /api/verification/runs/:runId/checks/:checkId?platform= -> {...check, evidence,
history: [{run_id, ran_at, status}] (10)}.

GET /api/datasets -> {active_id, rows: [{id, label, source, seed, status, verdict,
created_at, promoted_at, archived_at, platforms: [{platform, rows, min_date, max_date,
cost_usd}]}]}. GET /api/datasets/:id. POST /api/datasets/:id/verify -> run.
POST /api/datasets/:id/promote {force} -> dataset (409 when verdict fail without
force). POST /api/datasets/rollback {to} -> dataset.
POST /api/fixtures/generate {seed, months, people, profile, defects, promote} ->
{dataset_id, verdict, promoted}; broadcasts fixture.generated {id} then
dataset.promoted when promoted.

GET /api/settings -> the settings object. PUT /api/settings {patch} -> settings.
GET /api/settings/seat-rates -> rows of the active dataset; PUT replaces them
({rows: [{platform, month, rate_usd, licensed_seats}]}). GET /api/settings/lob-cg-map
-> rows; PUT replaces them and rebuilds people.lob_cg and rollup_org_month.
GET /api/export/:report.csv (summary, trend, platform, organization, models, users;
same params as the report) streams CSV whose first line is "# " + CAVEAT; formula
guard on cells starting with = + - @.

SSE event types: hello, ping, dataset.promoted {id}, dataset.verified {id, verdict},
settings.changed {keys}, fixture.generated {id}.

## 9. Frontend (owner C shell and first pages, owner D remaining pages)

Routes: / Landing, /overview, /platforms/:id, /organization, /models, /users,
/data-quality, /settings/:section?, /diagnostics. One Layout: sticky top Nav (AIxP
wordmark text with an accent dot, items Overview | Platforms (menu of four) |
Organization | Models | Users | Data quality | Settings, live dot, ThemeToggle),
PageTransition around the outlet, Footer (wordmark, links, CAVEAT, Diagnostics link).
No Trace3, FSG or Capital Group strings or images anywhere.

Landing (calm): PageHeader (eyebrow "Executive view", title "AI platform economics",
right slot: as-of chip and basis SegmentedControl); headline card with the month-to-date
spend in the selected basis (CountUp), a DeltaChip against the prior month same days,
and the word "directional" in the caption; FreshnessStrip (four as-of chips) with a
ConfidenceChip; four PlatformCards (spend, units with UnitBadge, active users, 30-day
sparkline in the platform colour) in a staggered grid; one weekly spend trend stacked by
platform (12 weeks); footer caveat. Nothing else.

Overview: stat tile row (spend in basis, consumption spend, seat spend, tokens,
credits, active users, attribution coverage percent), spend trend with
day/week/month toggle, share donut by platform, active users trend, raw vs attributed
spend bar, top 10 users table (opens UserDrawer).

Platform page: segmented platform switcher in the header; stat tiles (spend, units
labelled, active users, spend per unit when valid); spend trend; units trend with the
unit as the axis title; models table or EmptyState "This source does not report a
model"; top users; Freshness panel (as-of, lag, coverage) and Checks list opening
EvidenceDrawer. Cowork: persistent note about cumulative monthly credits valued at the
Cowork rate with a "reconfirm" badge while cowork.rate_confirmed is false. GitHub: gross,
discount and net figures shown side by side, never netted silently.

Organization: rows toggle (LOB-CG | Region | SBL | Person type), measure toggle (spend
| active users | units); Matrix rows x platform columns plus Total; Unmatched row always
last, muted stripe, tooltip "Usage whose identity did not resolve to a person. Shown so
raw and attributed totals can be compared."; cell hover (click on touch) opens
MatrixCellCard with the top five contributors and a View users link.

Models: DataTable with platform chips; row opens ModelDrawer. Users: server-paged
DataTable (50), debounced search (250 ms) in the URL, sortable headers, platform filter;
row opens UserDrawer and sets ?user=. Data quality: ConfidenceChip rollup with counts;
checks grouped by platform (status, name, last run, affected) with inline expand
(metrics plus meaning) and an Evidence button opening EvidenceDrawer; Datasets history
table with a "current" badge, Verify and Rollback actions behind a Dialog. Settings
(rail sections): Spend basis, Seat rates table, LOB-CG map, Cowork rate with reconfirm
checkbox, Fixtures (seed, months, people, profile, Regenerate button behind a Dialog,
toast on completion), Theme (system | light | dark). Diagnostics: copied, retitled.

Design tokens (frontend/src/index.css, CSS only, no tailwind.config): :root light
set, :root[data-theme="dark"] dark set, prefers-color-scheme dark block guarded by
:root:not([data-theme="light"]), and an @theme inline block mapping --color-bg-0,
--color-bg-1, --color-bg-2, --color-ink, --color-muted, --color-faint, --color-line,
--color-accent, --color-accent-soft, --color-ok, --color-warn, --color-fail,
--color-p-anthropic, --color-p-openai, --color-p-github, --color-p-cowork (and -soft
tints) to the live variables. Platform colours are dataviz categorical slots 1 to 4
(fallback #C4663A, #2A8C8C, #6B5BD2, #C99A2E; lifted in dark) and are used ONLY for
platform identity; status colours (fallback #2E8F63, #C98A14, #CF4B3F) always travel
with a glyph and a word. Fonts: Sora 600/700 (titles, headline, stat values) and Inter
400/500/600 (everything else) through one Google Fonts link; tabular-nums on every
number. Scale: display 44/48 (landing headline only), h1 28/34, h2 18/24, h3 14/20
uppercase tracking .04em, body 14/20, small 12/16, micro 11/14. Spacing 4 px base,
card padding 16, gutter 24 at 1024 and 40 at 1440, grid gap 16, section gap 32.
Radius 12 cards, 8 inputs and chips, pills 9999. Light: shadow-1 on cards, shadow-2 on
hover cards and drawers; dark: 1 px line borders. Charts sit in fixed-height boxes (220
or 280). lib/format.js: money compact ($1.24M, $340K; one decimal under $10M),
moneyFull, units(n, unit) always appending the unit word, count, pct, dateLong
"27 Oct 2026", lag ("current", "2 days behind", "stale (9 days)").

Charts: keep chartSetup.js's animation guard and the valueLabels plugin; the ONLY way
to change animation is mutating Chart.defaults.animation.duration and .easing, never
assigning a new object; add syncChartTheme() that reads the CSS variables and mutates
Chart.defaults.color, borderColor, font family and the plugin colours (called by the
ThemeProvider on mount and on change, and sets duration 0 under reduced motion).
Sparkline takes a color prop. Every chart card has a one-line caption naming units and
basis and an aria-label on the canvas wrapper. No dual axes, no 3D.

Motion budget: nothing over 400 ms, stagger step 40 ms, nothing loops except the
skeleton shimmer (static under reduced motion). PageTransition keyed by first path
segment; platform switch cross-fades the content 120 ms; CountUp 400 ms; lib/motion.js
stagger variants on the landing cards and stat rows; Drawer 200 ms slide with 150 ms
scrim; Dialog scale 0.98 to 1 in 180 ms; HoverCard 120 ms in, 80 ms out, 150 ms open
delay; chip colour transitions 200 ms; card hover 2 px lift. Not animated: nav, tables,
matrix cells, tooltips, theme switch. AnimatedNumber is not used (ignores reduced
motion); CountUp is.

Popups: Tooltip (one line) < HoverCard (rich, opens on hover and focus, never the only
path to an action) < Drawer (right, 520 px, URL-linked ?user= ?model= ?check=, focus
trapped, Esc closes, focus returns) < Dialog (confirmations). Drawer and Dialog get a
shared useFocusTrap hook and aria-modal.

Data: lib/query.js useQuery(path, params, {events}) with a module Map keyed by the
sorted URL, stale-while-revalidate 30 s, in-flight dedupe, last good data kept on error,
SSE invalidation through useLiveRefresh debounced 150 ms, full clear on
fixture.generated. lib/filters.js useUrlFilters(defaults) over useSearchParams: keys
from, to, bucket, platform, basis, rows, measure, q, sort, page, user, model, check;
defaults not written; user/model/check push history so Back closes the drawer. Every
page handles loading (skeleton of the final shape after 150 ms), error without data
(EmptyState with Retry), error with data (inline warning), and empty. CSV export is a
plain anchor to the export route.

Mock data: until B lands, C builds against frontend/src/mock/*.json files shaped
exactly like section 8 (summary.json, trend.json, platform-anthropic.json, etc.),
switched by VITE_MOCK=1 in lib/api.js. D uses the same mechanism. The mock files stay
in the repo as fixtures for future UI work.

Accessibility: ink on bg-1 at least 7:1, muted 4.5:1, faint 3:1 (axis ticks only);
status never by colour alone; table rows are buttons; aria-sort on headers; segmented
controls are radio groups; skip link; tables 14 px, 36 px rows with a compact toggle,
right-aligned numerals.

## 10. File ownership

Shared, placed by Fable, edited only with Fable's agreement: backend/src/app.js
(B edits mountRoutes only), auth.js, errors.js, services/events.js, buildId.js,
time.js, settings.js (B fills VALIDATORS), tests/helpers.js, docs/*.

Builder A (backend data): backend/src/db.js, defaults.js, platforms.js,
services/staging.js, normalize.js, datasets.js, fixture.js, verify/**,
scripts/gen-fixture.js, tests/fixture.test.js, normalize.test.js, datasets.test.js,
verify.test.js, tests/seed.js (seedFixture helper for other suites).

Builder B (backend API): backend/src/server.js, routes/*.js, services/rollups.js
(build(db, id), drop(db, id), rebuildOrg(db, id)), measures.js, reports.js,
csvExport.js, VALIDATORS in settings.js, mountRoutes in app.js, tests/rollups.test.js,
reports.test.js, settings.test.js, export.test.js, auth.test.js; docs/API.md updates.

Builder C (frontend shell): frontend/index.html, src/index.css, main.jsx, App.jsx,
lib/*, components/ui/* (except DataTable.jsx), components/charts/*,
components/analytics/*, components/CountUp.jsx, Layout.jsx, Nav.jsx, Footer.jsx,
PageHeader.jsx, ThemeToggle.jsx, FreshnessStrip.jsx, ConfidenceChip.jsx,
PlatformCard.jsx, FilterBar.jsx, AuthGate.jsx, PageTransition.jsx,
drawers/DrawerHost.jsx plus stub UserDrawer.jsx, EvidenceDrawer.jsx, ModelDrawer.jsx,
pages/LandingPage.jsx, OverviewPage.jsx, PlatformPage.jsx, DiagnosticsPage.jsx,
mock/*.json, public/* (favicon as an SVG wordmark, no logos).

Builder D (frontend pages): components/ui/DataTable.jsx, components/org/*,
components/settings/*, drawers/UserDrawer.jsx, EvidenceDrawer.jsx, ModelDrawer.jsx
(replacing C's stubs in place: same file names, default export, props {open, id,
onClose, ...}), pages/OrganizationPage.jsx, ModelsPage.jsx, UsersPage.jsx,
DataQualityPage.jsx, SettingsPage.jsx. D appends its route lines to App.jsx inside the
block marked "// D routes" and touches nothing else in C's files.

Seam order: A's schema commit and C's shell commit land first; B and D start after.
B calls only datasets.*, staging.*, fixture.generate, verify CHECKS and run,
PLATFORMS and CAVEAT; B never writes stage_* or usage. D uses C's primitives only
through components/ui/index.js and components/charts; C's pages call
useDrawers().openUser(key) / openCheck(id, platform) / openModel(platform, model) and
never import D's drawers directly.

## 11. Definition of done

- backend: npm test green (every file), node scripts/gen-fixture.js --seed-db
  --profile defective then GET /api/summary verdict fail naming GitHub stale; --profile
  clean verdict pass; rollback restores the prior dataset; /api/trend totals equal
  SELECT SUM(cost_usd) FROM usage for the dataset and range; every GET under 200 ms
  warm; unknown /api paths 404 JSON.
- frontend: npm run build green; every route renders from the fixture API with zero
  console errors in light and dark at 1440 and 1024; reduced motion honoured; keyboard
  through every drawer; URL round trips; units audit (no unlabelled or combined
  token+credit figure); branding grep clean; ASCII scan clean.

## 12. Reports and the 24 hour range (addendum 2026-11-03, builders E backend and F frontend)

Range presets everywhere a DateRangePicker appears: "24 hours" (from = to = asOf, one
day), "7 days", "30 days", "90 days", "6 months", "12 months", "Custom". A one-day range
is valid on every route (from == to); prior period is the previous day; day grain is
forced on trend charts when the range is under 14 days. The default stays 90 days.

A report is a parameterised table with an optional chart and a CSV export. Catalogue and
shapes (backend/src/services/reportCatalog.js owns the list; the frontend reads it from the
API, never hard-codes it):

GET /api/reports -> {groups: [{id: users|platforms|models|costs, title}], reports: [{id,
group, title, description, params: ['range','platform','basis','dim','limit'] subset,
columns: [{key, label, type: text|money|number|units|pct|date|platform|delta}]}]}
GET /api/reports/:id?from&to&platform&basis&dim&limit -> {id, title, description, asOf,
range: {from, to}, params: {...resolved}, columns, rows: [{...}], totals: {...} | null,
chart: {type: bar|line|stacked, labels: [], series: [{label, data: [], platform: id|null}]}
| null, notes: [string]}. Units columns carry {value, unit} objects; money columns carry
numbers in USD; delta columns carry {now, prev, delta, pct}. limit default 50, max 500.
GET /api/export/report/:id.csv same params; first line "# " + CAVEAT.

| id | group | rows | columns | chart |
|---|---|---|---|---|
| users_top | users | top users by spend in range | rank, user, lob_cg, region, usd, per-platform usd, active_days, share | bar top 10 |
| users_new | users | users whose first activity in the dataset falls in range | user, lob_cg, first_seen, first_platform, usd_since, platforms | line new users per week |
| users_inactive | users | users active in the 90 days before the range but not in it | user, lob_cg, last_seen, days_silent, usd_before | none |
| users_multi_platform | users | users active on 2+ platforms | user, lob_cg, platform_count, per-platform usd, usd | bar count by platform_count |
| users_by_group | users | active users and spend per dim (default lob_cg; dim param) | group, users, usd, usd_per_user, share | bar usd per group |
| users_unmatched | users | usage keys absent from People | person_key, platforms, rows, usd, first_seen, last_seen | none |
| platforms_summary | platforms | one row per platform | platform, as_of, lag_days, consumption_usd, seat_usd, total_usd, consumption {value,unit}, active_users, usd_per_active_user, licensed_seats, seat_utilisation_pct | bar total usd |
| platforms_monthly | platforms | month x platform spend (basis) | month, per-platform usd, total, delta vs previous month | stacked by platform |
| platforms_freshness | platforms | per platform | platform, as_of, lag_days, stale, coverage_from, coverage_to, rows, checks_failed, checks_warn | none |
| platforms_seat_utilisation | platforms | platform x month | platform, month, licensed_seats, active_people, utilisation_pct, seat_usd, consumption_usd, usd_per_active | line utilisation per platform |
| models_cost | models | one row per platform+model | platform, model, usd, consumption {value,unit}, requests, users, cost_per_million (token platforms), share | bar usd top 10 |
| models_adoption | models | week x model active users (top 8 models) | week, per-model users | line |
| models_by_group | models | dim x model spend (top 8 models, dim param default lob_cg) | group, per-model usd, total | stacked |
| costs_monthly | costs | one row per month in range | month, consumption_usd, seat_usd, total_usd, delta_total, active_users, usd_per_user | stacked consumption+seat |
| costs_by_group | costs | dim rows (default lob_cg) | group, consumption_usd, seat_usd (allocated), total_usd, share, users, usd_per_user | bar |
| costs_movers | costs | platform and group rows ranked by absolute change vs the previous window | kind, name, now, prev, delta, pct | bar delta |
| costs_per_user | costs | per platform | platform, active_users, usd, usd_per_user, consumption_per_user {value,unit} | bar usd_per_user |

Rules: spend follows the basis param where the row is a spend figure (seat allocation as
in /api/organization); tokens and credits are never summed; every report answers under
300 ms warm on the default fixture; reports read rollup_* only (usage only for
users_unmatched first/last seen and models requests if not in rollups). Builder E owns
backend/src/services/reportCatalog.js, services/reportRunner.js, routes/reports.js, the
report branch of routes/export.js, tests/reportsCatalog.test.js (every report answers with
its declared columns on a seeded fixture, one-day range works, CSV first line). Builder E
also allows from == to in measures.resolve if anything rejects it (it does not today) and
adds "7 days" nothing server-side (ranges are client presets).

Frontend (builder F): Sidebar gets "Reports" after Data quality; routes /reports (catalogue:
four groups of cards with title and description, card hover shows the columns, click opens
the report) and /reports/:id (PageHeader with the report title, FilterBar with range,
platform and basis where the report's params allow, dim SegmentedControl when 'dim' is a
param, the chart in a Card when present, DataTable of rows with column types rendered
through lib/format.js and UnitBadge, totals row when present, notes under the table,
Export CSV anchor to /api/export/report/:id.csv with the current params, "Open in users"
link on user rows via useDrawers().openUser). DateRangePicker gains the "24 hours" and
"7 days" presets (values '1' and '7'); a one-day range shows "24 hours to <date>" in the
RangeNote. Mock files: src/mock/reports.json and src/mock/report-<id>.json for at least
users_top, platforms_summary, models_cost, costs_monthly (api.js mock mapping: /reports ->
reports.json, /reports/<id> -> report-<id>.json).

## 13. Power BI connector (addendum 2026-11-03, builders G backend and H frontend)

Purpose: pull real rows from the AI Platform Economics semantic model through the Power BI
REST API and load them through the existing staging -> normalize -> verify -> promote seam
(section 5). The fixture path stays; a dataset's source becomes 'import' with
options_json.provider = 'powerbi'.

Power BI facts (binding): auth is Azure AD client credentials, POST
https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token with scope
https://analysis.windows.net/powerbi/api/.default; queries run through POST
https://api.powerbi.com/v1.0/myorg/groups/<workspaceId>/datasets/<datasetId>/executeQueries
with body {queries: [{query: '<DAX>'}], serializerSettings: {includeNulls: true}}; the
answer is results[0].tables[0].rows, each row an object whose keys look like
"Usage[Date]" (headerKey already strips the Table[...] wrapper); one query returns at most
100,000 rows and 15 MB, so pulls are chunked. Discovery: GET
.../groups/<workspaceId>/datasets lists {id, name}. The service principal must be allowed
by the tenant setting "Service principals can use Fabric APIs" and be a Member or
Contributor of the workspace; no delegated permission is needed. A pasted user bearer token
is accepted as a second auth mode for a first test. Known ids from the primer, used as
placeholders only: tenant 41b8c056-2dc3-438d-99ee-61e00287adfe, workspace
5e413bf1-69f1-4c08-9050-e320acd1e78c; the dataset id is discovered.

Settings keys (defaults.js, validators in settings.js): powerbi.enabled false,
powerbi.auth_mode 'service_principal' | 'token', powerbi.tenant_id, powerbi.client_id,
powerbi.workspace_id, powerbi.dataset_id, powerbi.dataset_name, powerbi.tables
{usage: 'Usage', people: 'People', seat_rate: 'SeatRate', region_map: 'RegionMap',
lob_cg_map: 'LobCgMap'} (table name or a full DAX query starting with EVALUATE; blank
= skip that table and keep the fixture's lookup rows from the active dataset),
powerbi.date_column 'Date', powerbi.months_back 13, powerbi.auto_promote true (promote
when the verdict is not fail; a fail stays verified for a human to promote with force),
powerbi.schedule '' or 'HH:MM' (daily, Phoenix), powerbi.last_pull_at, powerbi.last_pull
{dataset_id, verdict, rows, duration_ms, error}. Secrets powerbi.client_secret and
powerbi.token are stored ENCRYPTED (services/secrets.js, AES-256-GCM, key from env
AIXP_SECRET_KEY or a generated backend/data/.secret-key file, 0600), never logged, and
GET /api/settings returns them as {set: true|false}; PUT with '' clears and the masked
object keeps.

Routes (routes/powerbi.js, all admin = password-gated like everything else):
POST /api/powerbi/test -> {ok, auth: {ok, expires_in}, workspace: {ok, name},
dataset: {ok, name}, tables: [{key, name, ok, rows | error}], latest: {usage_max_date}}
GET /api/powerbi/datasets -> [{id, name}] for the configured workspace
POST /api/powerbi/pull {promote?: bool} -> {dataset_id, verdict, promoted, rows,
duration_ms}; 409 when a pull is already running; progress by SSE import.progress
{stage: auth|usage|people|lookups|normalize|verify|promote|done|error, table, chunk,
rows, message}; the dataset is created with source 'import', label 'Power BI <dataset
name> <YYYY-MM-DD HH:MM>'; on error the dataset is marked failed with note = message.
GET /api/powerbi/status -> {configured, enabled, running, last_pull_at, last_pull,
schedule, next_run_at}

Chunking (services/powerbiClient.js and powerbiImport.js): Usage is pulled one calendar
month at a time from months_back months before asOf (asOf = MAX of the date column, asked
first with EVALUATE ROW("d", MAX('Usage'[Date]))) using CALCULATETABLE('Usage',
'Usage'[Date] >= DATE(y,m,1) && 'Usage'[Date] < DATE(y,m+1,1)); a month answering 100,000
rows is split per platform (FILTER on the Platform column); a month+platform still at
the cap is split by half-month; still at the cap = error naming the slice. People and
lookups are pulled whole. Date values arrive as ISO strings ("2026-10-30T00:00:00"),
numbers as numbers; loadTables stores text as given. Rate limits: at most 4 queries in
flight (core/concurrency-style mapLimit), retry 429 and 5xx three times with backoff,
give up on 401/403 with the Power BI error text in the message. Token cached until 5
minutes before expiry.

Frontend (builder H): Settings gains a "Data source" section (rail item first, above
Spend basis): mode toggle Fixture | Power BI; Power BI panel with auth mode, tenant id,
client id, client secret (password field, "set" badge when stored, blank keeps), or
bearer token; workspace id; dataset picker (Discover button fills a select from GET
/powerbi/datasets); tables table (key, name or DAX, Test per row); months back; auto
promote; schedule time; buttons Test connection (renders the test result as a checklist
with StatusChips), Pull now (confirm Dialog, then a progress panel driven by SSE
import.progress with stage chips and a row counter, ends in a toast and a link to Data
quality), last pull summary. Landing and Overview as-of chip tooltip and the Data
quality datasets table show the dataset source ("Power BI pull" vs "Fixture"). Settings >
Fixtures stays. Help text under the panel states the tenant setting and workspace role
the service principal needs, in two sentences.

Tests (builder G): tests/powerbi.test.js with a fake Power BI server (express on port 0:
token endpoint, datasets list, executeQueries that serves fixture rows in Power BI
shape with "Usage[Date]" keys and enforces the 100,000 cap so the per-platform split is
exercised); test, pull end to end to an active dataset with verdict, secret encryption
round trip and masking, 409 while running, failure path marks the dataset failed.

## 14. Sign-in, local users, Active Directory and roles (addendum 2026-11-04, builders I backend and J frontend)

Purpose (Doug, 2026-11-04): a real login page; local users and Active Directory users;
custom roles assigned to AD groups, AD organizational units or AD users, or to local users
directly; local password resets by an administrator; the first account is admin / M0nkside;
AD is off by default and the admin only enters the domain plus one account that is allowed
to read the directory, everything else (domain controllers, base DN, TLS) is worked out in
the background; every failure names where it failed; an AD user is mapped to the
organizational unit and the org attributes AD already holds for them. Styling stays as it
is: the login page is the existing AuthGate card, the access pages are Settings sections
built from the primitives in components/ui and components/settings/shared.jsx.

The APP_PASSWORD shared-password gate is REPLACED. The env var is ignored after this round
(hermes keeps it in the pm2 env harmlessly). Every /api route except /api/health and
/api/auth/* needs a signed-in user; the SSE stream needs one too (the cookie rides on
EventSource).

### 14.1 Permissions (backend/src/services/permissions.js, owner I; the frontend reads them from the API)

Fixed catalogue, each a key with a label and a one-line description:

| key | grants |
|---|---|
| dashboard.view | landing, overview, platform pages, organization, models, data quality (read), reports (except the user reports), trend, summary, verification read, datasets list |
| people.view | /api/users list and detail, the user drawer, the users_* reports and the top users tables; person-level usage |
| export.csv | /api/export/* (a user report export also needs people.view) |
| data.manage | datasets verify, promote, rollback; fixtures generate; Power BI test, datasets, pull |
| settings.manage | GET and PUT /api/settings and its sub-routes (seat rates, LOB-CG map) |
| access.manage | /api/access/* (users, roles, assignments, directory, sign-in activity) |

A role is a named set of keys. System roles are seeded and cannot be deleted or have their
keys edited (name and description are read-only too): Administrator (every key),
Executive (dashboard.view, export.csv), Analyst (dashboard.view, people.view, export.csv),
Viewer (dashboard.view). Custom roles carry any subset. A user's effective permissions are
the union over every role reaching them (14.3). Enforcement is a table in
backend/src/auth.js keyed by method and path prefix; the frontend only hides what the
caller cannot use (the backend is the guard). A refused call answers 403 {error:
"You do not have permission to <verb>", required: "<key>"}; the frontend shows the
error text and, on a page-level refusal, an EmptyState "You do not have access to this
page" with the required key.

### 14.2 Schema (db.js additions, owner I; CREATE TABLE IF NOT EXISTS like the rest)

users: id, username TEXT UNIQUE NOT NULL (lowercase, trimmed; for AD users the sAMAccountName
lowercased), display_name, email, source TEXT NOT NULL ('local' | 'ad'), password_hash
(local only; scrypt, format "scrypt$N$r$p$<salt b64>$<hash b64>", N 16384 r 8 p 1, 16 byte
salt, 32 byte key; argon2 is NOT used because npm 12 blocks native install scripts),
default_password INTEGER (1 while the seeded admin still has M0nkside; cleared on change),
active INTEGER NOT NULL DEFAULT 1, ad_dn, ad_sid, ad_upn, ad_guid, ad_groups_json (group
DNs and SIDs at the last login or sync), ad_ou (the OU part of the DN: everything after the
first RDN, e.g. "OU=Engineering,OU=Users,DC=corp,DC=example,DC=com"), ad_attrs_json
({department, company, division, title, office, manager, employee_id, country}, whatever
AD returned), person_key (the People row whose email matches the user's email in the active
dataset, refreshed at login and at promote; NULL when none), created_at, updated_at,
last_login_at, failed_logins INTEGER DEFAULT 0, locked_until TEXT.

roles: id, name UNIQUE, description, system INTEGER DEFAULT 0, permissions_json (array of
keys), created_at, updated_at.

role_assignments: id, role_id, subject_type ('user' | 'ad_group' | 'ad_ou'), user_id
(subject_type user), ad_dn, ad_sid, ad_name (ad_group and ad_ou: the DN is the identity,
SID kept for groups, name for display), created_at, UNIQUE(role_id, subject_type,
user_id, ad_dn).

sessions: token_hash TEXT PRIMARY KEY (sha256 of the cookie value), user_id, created_at,
last_seen_at, expires_at, ip, user_agent. Sessions live 12 hours idle and 7 days absolute;
last_seen_at is bumped at most once a minute. Every session of a user is dropped when the
user is disabled, deleted, or has the password reset by an admin (own self-service change
keeps the current session only).

auth_events: id, at, kind ('login_ok' | 'login_fail' | 'login_locked' | 'logout' |
'password_change' | 'password_reset' | 'user_created' | 'user_updated' | 'user_deleted' |
'role_created' | 'role_updated' | 'role_deleted' | 'assignment_added' |
'assignment_removed' | 'ad_test' | 'ad_sync' | 'ad_config'), username, user_id, source,
ip, detail (plain text, never a password or secret), actor_user_id. Kept 180 days
(pruned at boot and once a day).

First boot (server.js and tests/helpers after db.open): when the users table is empty,
insert admin / M0nkside (display_name Administrator, source local, default_password 1)
and assign the Administrator role; log "[auth] seeded the initial administrator account
admin (change its password under Settings > Users)". Settings > Users shows a warning
banner while any active user still has default_password = 1.

### 14.3 Sign-in rules (backend/src/services/authService.js and auth.js, owner I)

POST /api/auth/login {username, password}. Resolution order:
1. username is trimmed and lowercased. "DOMAIN\name" and "name@domain" are domain
   qualified; a bare name is tried as a LOCAL user first, then as a domain user when AD is
   enabled and no active local user has that name.
2. Local: user missing, disabled, or wrong password all answer 401 {error: "Wrong username
   or password", code: "bad_credentials"} (the audit row says which); after 5 failures in
   10 minutes the account locks for 15 minutes: 423 {error: "Too many failed sign-ins.
   Try again in N minutes.", code: "locked"}.
3. AD (ad.enabled true): the user binds AS THEMSELVES on a fresh connection (that is the
   password check), then the service account reads their record and transitive groups
   (nested through matching rule 1.2.840.113556.1.4.1941, primary group by RID, disabled
   accounts rejected). Outcomes: bad password 401 bad_credentials; disabled in AD 401
   {code: "ad_disabled", error: "This domain account is disabled."}; valid user but no role
   reaches them 403 {code: "no_role", error: "Your domain account signed in but no AIxP
   role is assigned to you, your groups or your organizational unit. Ask an
   administrator."}; domain controllers unreachable or the service account failing 503
   {code: "ad_unreachable", error: "<the mapped error, 14.5>", detail: [attempt lines]}.
   Local sign-in keeps working during an AD outage. Three AD failures for one name in 10
   minutes pause further AD attempts for that name for 10 minutes (the app must not lock
   the domain account): 423 code "locked".
4. On an AD success the user row is upserted by ad_guid (fallback ad_sid, then
   username + source ad): display_name, email, ad_dn, ad_upn, ad_ou, ad_groups_json,
   ad_attrs_json refreshed; person_key refreshed from the active dataset's people by
   email (lowercase). A pre-provisioned AD user (14.4, added by an admin before their
   first login) is matched the same way.
5. Effective permissions = union of roles assigned to: the user directly (subject user);
   any ad_group whose DN (case-insensitive) or SID is in the user's groups; any ad_ou
   whose DN is a suffix of the user's DN (case-insensitive, boundary at a comma). Local
   users only get direct assignments. An active user with zero permissions cannot sign in
   (403 no_role for both sources; message for local: "This account has no role. Ask an
   administrator.").
6. Success: a 32 byte random token, cookie aixp_session=<token>; HttpOnly; SameSite=Lax;
   Path=/; Max-Age=604800 (Secure is added when the request arrived over https, judged by
   x-forwarded-proto https or req.secure); answer = the session body below.

CSRF: every non-GET /api request (login included) must carry the header
x-aixp-csrf: 1, else 403 {error: "Missing request header", code: "csrf"}. The frontend
api.js adds it to every non-GET call. Cross-site forms cannot set it.

GET /api/auth/session -> {authenticated: true, user: {id, username, display_name, email,
source, default_password, person_key, ad_ou, ad_attrs}, permissions: [keys], roles:
[{id, name}], ad: {enabled, domain}} or {authenticated: false, ad: {enabled, domain}}
(200 both ways). POST /api/auth/logout -> {ok}. POST /api/auth/change-password
{current_password, new_password} (local users; 400 when the current one is wrong or the
new one is under 10 characters; clears default_password; keeps the current session,
drops the others) -> {ok}. AD users get 400 {error: "Domain passwords are changed in
Active Directory, not here."}.

Password rule everywhere: 10 to 128 characters, no other composition rule; the message
says exactly that.

### 14.4 Access routes (backend/src/routes/access.js, owner I; all need access.manage)

| Method | Path | Body / notes |
|---|---|---|
| GET | /api/access/permissions | [{key, label, description}] |
| GET | /api/access/users | {rows: [{id, username, display_name, email, source, active, default_password, last_login_at, created_at, locked_until, roles: [{id, name, via: 'direct' or 'group:<name>' or 'ou:<name>'}], ad_ou, ad_attrs, person_key}]} |
| POST | /api/access/users | {username, display_name, email, password, role_ids} creates a LOCAL user (409 on a taken username; 400 on the password rule) |
| POST | /api/access/users/ad | {dn} pre-provisions an AD user from a directory search (14.5): reads the record with the service account, inserts source ad, no password; 409 when present |
| PUT | /api/access/users/:id | {display_name, email, active, role_ids} (role_ids replaces the DIRECT assignments only); AD users accept active and role_ids only; the caller cannot disable themselves; the last active Administrator cannot be disabled |
| PUT | /api/access/users/:id/password | {password} admin reset of a local user; drops that user's sessions; sets default_password 0; 400 for an AD user |
| DELETE | /api/access/users/:id | not self, not the last active Administrator; drops sessions and direct assignments |
| GET | /api/access/roles | {rows: [{id, name, description, system, permissions, user_count, group_count, ou_count}]} |
| POST | /api/access/roles | {name, description, permissions} (name 2 to 60 chars, unique case-insensitive; permissions must be catalogue keys, at least one) |
| PUT | /api/access/roles/:id | same fields; a system role answers 400 "System roles cannot be edited" |
| DELETE | /api/access/roles/:id | 400 for a system role; otherwise removes its assignments too |
| GET | /api/access/roles/:id/assignments | {rows: [{id, subject_type, user: {id, username, display_name, source} or null, ad_dn, ad_sid, ad_name, created_at}]} |
| POST | /api/access/roles/:id/assignments | {subject_type: 'user', user_id} or {subject_type: 'ad_group' or 'ad_ou', ad_dn, ad_sid, ad_name}; 409 duplicate; ad_* need ad.enabled |
| DELETE | /api/access/roles/:id/assignments/:aid | |
| GET | /api/access/directory | {config (ad.* keys, bind_password as {set}), discovered: {servers, base_dn, url, at, error}, status: {last_test_at, last_test_ok, last_test, last_sync_at, last_sync}, user_count} |
| PUT | /api/access/directory | patch of ad.* keys (14.5); saving runs discovery in the background and answers at once with the saved config; secrets follow the settings rules ('' keeps, null clears) |
| POST | /api/access/directory/test | the checklist (14.5); 200 even when a step fails |
| GET | /api/access/directory/search?type=user,group,ou&q= | type is one of user, group, ou; up to 50 rows: user {dn, sam, upn, display_name, email, disabled, ou}, group {dn, name, sid, description}, ou {dn, name, path}; 400 when AD is disabled; 503 with the mapped error when unreachable |
| POST | /api/access/directory/sync | refreshes ad_groups_json, ad_ou, ad_attrs_json, active (disabled in AD -> active 0 when ad.deactivate_removed) for every AD user; {users, updated, deactivated, errors: []}; also runs every ad.sync_minutes when enabled |
| GET | /api/access/events?limit=200&kind= | {rows} newest first |

Every mutation writes an auth_events row with actor_user_id and broadcasts
access.changed {what: users, roles, assignments or directory}.

### 14.5 Active Directory (backend/src/services/directory.js, owner I)

Dependency: ldapts ^9 (pure JavaScript, no install script; already installed). Settings
keys (defaults.js, VALIDATORS in settings.js): ad.enabled false, ad.domain '' (lowercased),
ad.bind_user '' (typed as name, DOMAIN\name or name@domain; bound as the UPN form),
ad.bind_password (SECRET, encrypted like the Power BI secrets, add it to SECRET_KEYS),
ad.servers '' (comma or space separated; blank = discover), ad.base_dn '' (blank =
discover), ad.tls_mode 'auto' | 'ldaps' | 'starttls', ad.tls_verify true, ad.ca_cert ''
(PEM), ad.sync_minutes 60 (5..1440), ad.deactivate_removed true, ad.discovered {servers,
base_dn, url, at, error} (written by the service, not the validator), ad.status
{last_test_at, last_test_ok, last_test, last_sync_at, last_sync}. GET /api/settings
(settings.manage) omits every ad.* key; the directory page reads /api/access/directory
instead. ad.* keys are rejected by PUT /api/settings with 400 "Directory settings are
saved under /api/access/directory".

Background discovery, on save and on every test: domain controllers from DNS SRV
_ldap._tcp.dc._msdcs.<domain> then _ldap._tcp.<domain> (sorted by priority then weight;
ad.servers overrides); base DN from the domain (dc=a,dc=b) confirmed against the RootDSE
defaultNamingContext; transport LDAPS 636 first, StartTLS on 389 second, unless ad.tls_mode
pins one; a server typed as ldaps://, starttls:// or ldap:// pins its own transport (ldap://
is plain and labelled "passwords cross the wire unencrypted" in the UI). tlsOptions go ONLY
on an ldaps:// client (handing them to a plain client makes ldapts negotiate TLS on 389
and the DC resets the socket). Connect timeout 8 s, operation timeout 30 s, paged searches
of 500. The reference implementation to copy from is
D:\VSCode Projects\CohesityDashBoard\Dashboard\backend\services\directory.js (read it,
port the pure helpers and connect() verbatim, adapt the settings calls).

Error mapping (the strings the admin sees; keep them): "No domain controllers found for
<domain>. Add DNS SRV records or list servers explicitly."; "<server> requires LDAP
signing: authenticated binds must use LDAPS or StartTLS, and neither could be established
(<attempts>). Install a server certificate on the domain controller." (LDAP error 8);
"Invalid credentials." (LDAP 49 / data 52e, stops at the first DC so the account is not
locked out); "TLS handshake failed (the domain controller offered no certificate on 636?)";
"StartTLS refused: the domain controller has no server certificate (LDAP error 52)";
"connection refused"; "connection timed out"; "hostname did not resolve"; "Could not
connect to any domain controller: <attempt lines>". Every error object carries code
(NO_SERVERS, TLS_REQUIRED, INVALID_CREDENTIALS, UNREACHABLE, NOT_CONFIGURED) and attempts.

POST /api/access/directory/test answers a checklist, one step per line, each {key, ok,
label, detail}: dns (servers found and which record answered, or that ad.servers was
used), connect (the url that answered, transport, TLS verified or not), bind (bound as
<upn>), base_dn (confirmed by RootDSE or derived), users (count of person objects), groups
(count), ous (count), plus {ok: all steps ok, duration_ms, steps: [...]}. The test also
stores ad.status and ad.discovered. A test never throws on configuration; a missing
domain or account answers with the first step failed and the reason.

Attributes read for a user: sAMAccountName, userPrincipalName, displayName, cn, mail,
objectGUID, objectSid, userAccountControl, primaryGroupID, distinguishedName, department,
company, division, title, physicalDeliveryOfficeName, manager, employeeID, co. OU = the DN
minus its first RDN. Groups: sAMAccountName, cn, description, objectGUID, objectSid.
OUs: search (objectClass=organizationalUnit), name = ou attribute, path = the OU names from
the root down joined with " / ".

Tests (tests/directory.test.js, owner I) inject a fake client through setClientFactory and
a fake SRV resolver: discovery order, UPN forms, nested and primary groups, disabled users,
OU suffix matching, every error mapping, and the login outcomes of 14.3 end to end through
the app (local first, then AD; no_role; ad_unreachable keeps local login working).

### 14.6 Frontend (owner J)

- lib/auth.jsx: AuthProvider + useAuth() -> {loading, user, permissions, roles, ad, can(key),
  refresh(), logout()}. GET /api/auth/session once at mount and after login; api.js adds
  x-aixp-csrf: 1 to every non-GET and, on a 401 from any call while signed in, calls
  refresh() so the app falls back to the login page. VITE_MOCK: session answers an
  Administrator with every key.
- components/AuthGate.jsx becomes the login page (same card, same tokens): username and
  password fields, "Sign in", a line under the form "Domain accounts: use name@<domain>
  or DOMAIN\name" only when ad.enabled is true, the server's error text verbatim in the
  alert (bad_credentials, locked with the minutes, ad_unreachable with a "Details" fold
  showing the attempt lines, no_role, ad_disabled). Enter submits. No "forgot password"
  link (resets are by an administrator; say so in one muted line).
- Nav: an account menu at the right (display name, source chip "Local" or "Domain",
  Change password for local users opening a Dialog, Sign out). Settings link only with
  settings.manage, data.manage or access.manage.
- Sidebar: Users needs people.view; everything else dashboard.view; a user without
  dashboard.view lands on the first page they can see (Settings) and the landing route
  shows the EmptyState.
- Pages: a 403 from the page's main query renders EmptyState "You do not have access to
  this page" with the required key from the error body. Top users tables and user
  drawers are hidden without people.view (OverviewPage top 10 card, PlatformPage top
  users, report rows do not open the drawer).
- Settings page: the section list gains a group label "Access" with Users, Roles,
  Active Directory and Sign-in activity (ids users, roles, directory, activity), shown
  only with access.manage; the data sections need settings.manage or data.manage. Routes
  stay /settings/:section.
  - Users: DataTable (username, name, source chip, roles with their via text, active
    chip, last sign-in, default-password warning chip), toolbar "Add local user" (Dialog:
    username, name, email, password, roles checkboxes) and "Add domain user" (Dialog with
    a typeahead over /api/access/directory/search?type=user, disabled when AD is off),
    row menu Edit (Dialog: name, email, active, roles), Reset password (Dialog: new
    password typed twice; shows "Signs the user out everywhere"), Disable / Enable,
    Delete (confirm Dialog). Warning banner while any user has default_password.
  - Roles: cards or a table of roles (name, description, system chip, permission chips,
    counts), "New role" and Edit Dialog (name, description, permission checkboxes with
    their descriptions), Delete with confirm, and an Assignments panel per role: three
    lists (users, AD groups, AD OUs) with Add (typeahead over the directory search for
    groups and OUs, a select of users for users) and remove.
  - Active Directory: Enabled toggle, Domain, Service account, Password (SecretField
    pattern from DataSourceSection), Advanced fold (servers, base DN, TLS mode
    SegmentedControl, verify certificate toggle, CA certificate textarea, sync minutes,
    deactivate removed toggle), "Save" and "Save and test" buttons, the Checklist (same
    row style as the Power BI test) and the discovered values (servers, base DN, url,
    when) under it, "Sync now" with the last sync summary. Plain-English hint lines:
    what the service account needs (a normal domain account that can read the directory,
    no admin rights), that LDAPS needs a certificate on the DC, and what each error means.
  - Sign-in activity: DataTable of auth_events newest first with a kind filter.
- Mocks: src/mock/auth-session.json, access-users.json, access-roles.json,
  access-permissions.json, access-directory.json, access-events.json,
  access-directory-test.json.

### 14.7 Definition of done for this round

- backend: npm test green including tests/auth.test.js rewritten for users (admin seed
  signs in, wrong password 401, lockout 423, csrf 403, permission 403 with required,
  session cookie works on /api/summary and the SSE stream, logout, change password, admin
  reset drops sessions, role CRUD and assignment rules, last-admin guard), tests/access.test.js
  and tests/directory.test.js; every other suite signs in through a helpers.login()
  that returns a client sending the cookie and the csrf header (helpers.startApp gains
  login(username, password) and app.as(user) sugar; the seeded admin is used by default).
- frontend: npm run build green; login page, account menu, four access sections and the
  permission-gated navigation screenshot-QAed in light and dark; a Viewer sees no Users
  item, no top users, no Settings link; zero console errors; ASCII scan clean.
- live: pm2 aixp-dashboard restarted; signing in as admin / M0nkside works on
  localhost:3090; creating a custom role, a local user with it, signing in as that user
  and seeing only what the role allows; AD test against a real domain is NOT possible
  here (no DC reachable), so the fake-client suite and the error mapping are the proof
  and the first real Save and test is the fix loop.

## 15. Data scopes: line-of-business separation (addendum 2026-11-04, builders K backend and L frontend)

Purpose (Doug, 2026-11-04, from the customer): an administrator can designate a person,
such as a LOB manager, who sees only their own line of business and the users in it;
separation between LOB owners is strict (a manager never sees another LOB's figures, names
or rows, not even in a total); people like the COO see everything; the delegation is per
person, either a local user or an AD group (or OU), the same three principal kinds the
roles use.

Design in one paragraph: roles stay what they are (what you may DO). A new permission
data.all means "see every line of business". A user without data.all sees only the LOB-CG
values granted to them through scope grants, which are attached to a local user, an AD
group or an AD OU exactly like role assignments. The effective scope is the union of every
grant that reaches the user. A user with neither data.all nor a grant has an empty scope:
they can sign in and use whatever settings they are allowed, and every data route answers
403 code no_scope. Enforcement is central and fails closed: every data query receives the
caller's scope through one context object, and a service entered without a scope throws.

### 15.1 Permission and system roles (permissions.js, owner K)

Catalogue gains a seventh key, last in KEYS order:

| key | grants |
|---|---|
| data.all | every line of business; without it the caller sees only the LOB-CG values granted to them under Settings > Data scopes |

Label "All lines of business", description "See every line of business and the Unmatched
and Unassigned buckets. Without it, a user sees only the LOB-CG values granted to them."
System roles: Administrator (every key, now 7), Executive (dashboard.view, export.csv,
data.all), Analyst (dashboard.view, people.view, export.csv, data.all), Viewer
(dashboard.view only; a Viewer therefore needs a scope grant to see anything).
ensureSystemRoles already rewrites the system rows at boot, so existing installs pick the
new key up on restart. Custom roles created before this round do not get data.all; their
users become scoped (empty scope until granted) and the release note says so. The Roles
section shows data.all with its description like any other key.

### 15.2 Schema (db.js, owner K; CREATE TABLE IF NOT EXISTS; index statements beside it)

scope_grants: id INTEGER PRIMARY KEY, subject_type TEXT NOT NULL ('user' | 'ad_group' |
'ad_ou'), user_id INTEGER NOT NULL DEFAULT 0, ad_dn TEXT NOT NULL DEFAULT '', ad_sid TEXT,
ad_name TEXT, dim TEXT NOT NULL DEFAULT 'lob_cg', value TEXT NOT NULL, created_at TEXT NOT
NULL, created_by INTEGER, UNIQUE(subject_type, user_id, ad_dn, dim, value). dim is always
'lob_cg' in this round; the column exists so region and SBL grants can be added later
without a migration, and the validator rejects anything else with 400 "Only LOB-CG scopes
are supported". value is the stored people.lob_cg string, compared exactly as stored
(trimmed on input). The literal value 'Unassigned' is grantable and means the people whose
lob_cg is in UNASSIGNED_VALUES (reports.js:414). A grant whose value no longer appears in
the active dataset is kept and shown as "not in current data".

Indexes added by rollups.ensureIndexes (so they exist after every promote):
idx_rpd_platform_date ON rollup_person_day(dataset_id, platform, date) and
idx_people_lob ON people(dataset_id, lob_cg).

auth_events kinds gain scope_added and scope_removed (detail names the subject and the
values, never a secret).

### 15.3 Effective scope (authService.js, auth.js, owner K)

authService.effective(user) returns {permissions, roles, scope}. scope = {all: boolean,
lob_cg: string[], via: {<value>: ['direct' | 'group:<name>' | 'ou:<name>', ...]}}. all is
true when the effective permissions include data.all; then lob_cg is [] and via {}. Else
lob_cg is the sorted, deduplicated union of scope_grants rows reaching the user by the
SAME matching rules as role assignments (14.3 step 5: direct by user_id; ad_group by DN or
SID in ad_groups_json, AD users only; ad_ou by DN suffix at a comma boundary, AD users
only). Local users only get direct grants. Load scope_grants in one query beside the
role_assignments query; do not introduce a second code path for the matching, extract the
matcher into one function used by both.

auth.js gate sets req.auth = {user, hash, permissions, roles, scope}. GET /api/auth/session
and the login body gain scope: {all, lob_cg} (via omitted). Nothing else about sign-in
changes; an empty scope does not refuse sign-in.

### 15.4 Enforcement (services/scope.js, measures.js, reports.js, reportRunner.js, csvExport.js, routes, owner K)

The rule for every service: a data function takes ctx from measures.resolve(query, scope)
and scope is REQUIRED. measures.resolve throws new Error('scope missing') when the second
argument is undefined, and the global error middleware answers 500 for that, so an entry
point that forgets the scope fails loudly in tests rather than leaking. Every route handler
passes req.auth.scope. Internal callers (reportRunner.orgCall, modelsCost calling
reports.models, csvExport paths, anything else that calls a reports.* function) pass the
ctx scope through. grep for "measures.resolve(" and "reports\.[a-z]+\(" at the end and
account for every call.

services/scope.js exports:
- isEmpty(scope): !scope.all && scope.lob_cg.length === 0.
- peopleWhere(scope, alias = 'p'): {sql, params}. all: sql '' (no restriction). Scoped:
  "(<alias>.lob_cg IN (?, ...))" where a granted 'Unassigned' expands to
  "(<alias>.lob_cg IS NULL OR lower(trim(<alias>.lob_cg)) IN ('', 'unassigned', 'unknown'))"
  OR-ed in. The fragment is always appended with AND inside an existing WHERE.
- lobVisible(scope, value): boolean used for the organization keys and cell checks.
- assertNotEmpty(scope): throws an HttpError 403 {error: "No data scope is assigned to your
  account. Ask an administrator to grant a line of business.", code: "no_scope"}; called by
  measures.resolve for scoped callers with no values, so every data route answers it.

Query rules, applied in reports.js, measures.js and reportRunner.js:
1. rollup_person_day, rollup_person_month, usage and people reads: INNER JOIN people p
   (dataset_id, person_key) when the scope is not all, with peopleWhere in the WHERE. An
   unmatched usage key has no people row, so it drops out of every scoped read; that is the
   intended rule (Unmatched usage belongs to nobody's LOB).
2. rollup_platform_day and rollup_model_day are whole-estate tables. When scope.all they
   are read as today (no change in cost or shape). When scoped, two helpers in measures.js
   replace every direct read: platformDays(ctx) returns rows {date, platform, rows, cost_usd,
   tokens, credits, consumption, requests, active_users, matched_cost_usd,
   unmatched_cost_usd} computed from rollup_person_day JOIN people with the scope filter
   (active_users = COUNT(DISTINCT person_key) with the ACT predicate; matched_cost_usd =
   cost_usd; unmatched_cost_usd = 0), and modelDays(ctx) returns {date, platform, model,
   rows, cost_usd, tokens, credits, consumption, requests, active_users} from usage JOIN
   people with the scope filter. The callers (summary, trend, models, modelRows,
   platformReport, modelDetail, spendWindow, consumptionByPlatform, platformDates,
   rowCounts, topModels, modelsAdoption, costsPerUser and the rest) switch to the helpers
   for BOTH modes so there is one code path; the helpers themselves branch on scope.all
   and read the rollup table in the all case so the fast path keeps its cost.
3. active users anywhere (measures.activeUsers, trend buckets, platformReport, summary,
   report runners) are counted from rollup_person_day with the scope filter.
4. Seat spend for a scoped caller is ALLOCATED, never whole-estate: for each platform and
   month, seat_usd_in_scope = seat_usd(platform, month) x (active matched people in the
   scope's LOBs that month / active matched people that month), from rollup_org_month
   matched = 1 (the existing share rule at reports.js:504-533), 0 when the denominator is
   0. loadSeat(ctx) applies this when scoped and the summary and platform payloads carry
   seat_basis_note "Seat spend allocated to your lines of business by active people" so
   the UI can print it. The seat basis 'licensed' and 'active' choices keep their meaning
   for the whole-estate figure before allocation.
5. organization(ctx): rows are only the keys visible to the scope. For dim lob_cg that is
   the granted values (plus Unassigned when granted); for region, sbl and person_type the
   rows are whatever the scoped people produce. The __unmatched__ row is pre-seeded only
   when scope.all; the __unassigned__ row only when scope.all or 'Unassigned' is granted.
   The response carries scope: {all, lob_cg} so the page can label itself.
6. orgCell(ctx, dim, key, platform): a key the scope cannot see (dim lob_cg with a value
   outside the grants, __unmatched__ when scoped, __unassigned__ without the grant) answers
   403 {error: "That group is outside your data scope.", code: "out_of_scope"}. For other
   dims the cell is computed over the scoped people only. contributors (names) are
   returned only when the caller has people.view; otherwise contributors: [] and
   contributors_hidden: true.
7. userDetail(ctx, key): a person outside the scope answers 404 {error: "No such user"} (do
   not reveal existence). users(ctx): the lob_cg filter from the URL is intersected with
   the scope (a value outside it yields zero rows, not an error).
8. platformReport and modelDetail: top_users only with people.view (else top_users: [],
   top_users_hidden: true), and always scoped. The platform CSV (csvExport.js:65) writes
   the top users block only with people.view. The GitHub gross/discount/net block from raw
   usage is scoped too.
9. Verification: GET /api/verification (summary, no evidence) stays dashboard.view. GET
   /api/verification/runs/:runId and /runs/:runId/checks/:checkId need data.all (auth.js
   rule, 403 required 'data.all'), because evidence rows carry person keys from every LOB.
10. Reports: every runner receives ctx with scope; users_* runners join people with the
    filter; users_unmatched answers {rows: [], note: "Unmatched usage is only visible with
    the data.all permission"} when scoped; models_by_group and any runner reading raw usage
    apply peopleWhere; group runners (users_by_group, costs_by_group, costs_movers) come out
    of organization(ctx) and inherit rule 5. reportRunner.run passes scope into parseParams
    or ctx; the catalogue is unchanged.
11. datasets, fixtures, powerbi, settings, access routes: unchanged (they are not data
    reads of the estate). GET /api/datasets/:id counts stay whole-estate (metadata).
12. The SSE stream is unchanged. Promote and the LOB-CG map rewrite do not touch
    scope_grants; a changed value simply stops matching, visible as "not in current data".

auth.js RULES gains, before the default rule: GET /verification/runs... -> data.all.

Performance: the scoped platformDays over a 90 day window on the default fixture (400
people) must stay under the 200 ms smoke budget; the two indexes in 15.2 are for that.
scripts/smoke-shapes.js gains a second pass signed in as a scoped user (env SMOKE_SCOPED=1
creates a role "Scoped smoke" with dashboard.view, people.view, export.csv, a user
scoped.smoke with a grant for the first lob_cg value of the active dataset, runs every
route again, checks the budget, and asserts no row in any response carries a person_key or
lob_cg outside the grant; the user and role are deleted afterwards).

### 15.5 Access routes (routes/access.js, owner K; access.manage)

| Method | Path | Body / notes |
|---|---|---|
| GET | /api/access/scope-values | {values: [{dim: 'lob_cg', value, sort, people, in_active_dataset: true}]} = DISTINCT people.lob_cg of the active dataset with people counts, sorted by lob_cg_sort then name, plus {value: 'Unassigned', sort: 998} always present; values that exist only in grants are appended with in_active_dataset false |
| GET | /api/access/scopes | {rows: [{id, subject_type, user: {id, username, display_name, source} or null, ad_dn, ad_sid, ad_name, dim, value, in_active_dataset, created_at}]} sorted by subject then value |
| POST | /api/access/scopes | {subject_type: 'user', user_id} or {subject_type: 'ad_group' or 'ad_ou', ad_dn, ad_sid, ad_name}, plus dim 'lob_cg' and values: [string, ...] (1..200, each 1..200 chars, trimmed); inserts one row per value, skips values already granted to that subject, answers {rows: the subject's grants after}; ad_* subjects need ad.enabled (400 otherwise, same text as role assignments); user_id must exist |
| DELETE | /api/access/scopes/:id | |
| GET | /api/access/users | each row gains scope: {all, lob_cg: [{value, via}]} (via as in roles) |
| PUT | /api/access/users/:id | gains optional lob_cg: [values] which REPLACES the user's DIRECT grants (group and OU grants untouched), like role_ids |

Every mutation writes auth_events (scope_added / scope_removed, actor_user_id) and
broadcasts access.changed {what: 'scopes'}. docs/API.md gains these rows, the data.all key,
the scope field on the session body, the no_scope and out_of_scope errors, and the
data.all gate on verification evidence.

### 15.6 Frontend (owner L)

- lib/auth.jsx: state gains scope {all, lob_cg}; useAuth() exposes scope and
  scopeLabel() ("All lines of business" | "1 line of business: X" | "3 lines of business:
  A, B, C" | "No data scope"). Sign-in, sign-out and any access.changed SSE event clear
  the query cache (a grant change must not leave another scope's figures cached).
- Nav: a ScopeChip left of the account menu for signed-in users without scope.all: a
  neutral chip "Scope: X" (or "Scope: 3 LOBs" with a Tooltip listing them); hidden when
  scope.all. Mobile widths keep it on one line or drop the values and keep "Scope".
- Every data page: when the main query answers 403 code no_scope, render EmptyState
  "No data scope is assigned to your account" with the server's error text and the line
  "Ask an administrator to grant a line of business under Settings > Data scopes."
  (one shared component components/NoScope.jsx; pages already handle 403 with EmptyState,
  extend that path). The landing page's headline figure and the overview tiles say
  "Your lines of business" instead of the whole-estate wording when scoped (the
  PageHeader eyebrow or description, one line, not a banner).
- Seat basis: where the UI prints the seat or total basis for a scoped user, show the
  seat_basis_note from the payload as the chart caption (summary, platform page).
- OrganizationPage and Matrix: render whatever rows the API returns; do not assume
  __unmatched__ or __unassigned__ exist (OverviewPage.jsx:57 and :138 unmatched lookups
  must tolerate absence). MatrixCellCard: an out_of_scope 403 shows one muted line.
  contributors_hidden renders "Contributors need the people.view permission".
- UsersPage: the lob_cg filter chip values are limited to the scope when not all; a URL
  filter outside the scope shows the chip and zero rows (server rule).
- PlatformPage, ModelDrawer: top_users_hidden renders nothing (the table is already gated
  by can('people.view')).
- DataQualityPage and EvidenceDrawer: the Evidence button and drawer need
  can('data.all'); without it the row shows a muted "Evidence needs the data.all
  permission" tooltip.
- Settings > Access gains "Data scopes" (id scopes) between Roles and Active Directory:
  - Intro line: "A user without the data.all permission sees only the lines of business
    granted here. Grants reach a user directly, through an AD group, or through an AD
    organizational unit. The Executive and Analyst roles include data.all."
  - A table grouped by subject (user / AD group / AD OU with the name and a source chip),
    one row per subject, LOB chips per row (a chip whose value is not in the active
    dataset gets a muted "not in current data" style and a Tooltip), remove (x) per chip
    with a confirm Dialog, and a toolbar "Grant scope" Dialog: SegmentedControl Local
    user | AD group | AD OU (the AD options disabled with the reason when AD is off), a
    select of users (local and domain) or the DirectoryPicker typeahead used by the
    Roles assignments, then a checkbox list of scope-values (search box above it when
    more than 12, 'Unassigned' listed last with its meaning), Save posts
    /access/scopes.
  - A second panel "Who sees everything": the roles that carry data.all with their
    assignment counts, read-only, linking to the Roles section.
- UsersSection: a Scope column (chips "All" when scope.all, else the LOB values with the
  via text in a Tooltip, or a muted "none"); the Edit dialog gains a "Lines of business"
  checkbox list (direct grants only; inherited ones are listed read-only under it with
  their via), saved through PUT /access/users/:id lob_cg. The Add local user and Add
  domain user dialogs gain the same list.
- RolesSection: nothing new beyond the catalogue key appearing (data.all), but the
  permission checkbox list orders data.all last with its description.
- Mocks: auth-session.json gains scope; access-users.json rows gain scope; new
  access-scopes.json and access-scope-values.json; organization.json unchanged.

### 15.7 Definition of done for this round

- backend: npm test green, new tests/scope.test.js covering: fixture seeded, people
  re-labelled into LOB A and LOB B in the test (UPDATE people SET lob_cg), a custom role
  "LOB manager" (dashboard.view, people.view, export.csv) and user mgr.a with a direct
  grant for A; then as mgr.a: /summary spend per platform equals SUM(cost_usd) over
  rollup_person_day JOIN people WHERE lob_cg = 'A' in the range, active users equals the
  distinct count, /trend buckets sum to the same, /platforms/:id spend and top_users all
  A, /models and /models/:p/:m users all A, /organization rows are exactly A (no
  Unmatched, no Unassigned, no B), /organization/cell for B answers 403 out_of_scope,
  /users rows all A and ?lob_cg=B answers zero rows, /users/<B key> answers 404, every
  report id in the catalogue answers 200 (users_unmatched with the note) and no row
  carries a B person_key, display_name or lob_cg (serialize the JSON and search for the B
  names and keys), /export/users.csv and /export/platform.csv and every
  /export/report/<id>.csv the same, /verification/runs/:id answers 403 required data.all;
  a user with the role but no grant answers 403 no_scope on /summary, /users, /reports/
  costs_monthly and /export/summary.csv and 200 on /auth/session; an AD-source user row
  inserted directly with ad_groups_json containing a group DN gets the group's grant
  (scope on login body via helpers login after setting a local password hash is not
  possible for AD, so call authService.effective directly), and an OU grant matches by DN
  suffix and not by a partial match ("OU=Sales" must not match "OU=Presales"); a data.all
  user's /summary equals the admin's; measures.resolve without a scope throws; the
  'Unassigned' grant shows the Unassigned people and nothing else; seat allocation:
  scoped seat spend equals whole x (A active / all active) for one month checked by hand.
- Existing tests: auth.test.js permission matrix gains data.all (7 keys, Administrator 7,
  Executive 3, Analyst 4, Viewer 1); reports and export tests pass the admin scope through
  the helpers (helpers.startApp clients are unchanged; service-level tests that call
  reports.* directly pass {all: true, lob_cg: []}).
- smoke: node scripts/smoke-shapes.js green, then SMOKE_SCOPED=1 node
  scripts/smoke-shapes.js green under the 200 ms budget.
- frontend: npm run build green; screenshot QA light and dark: Nav ScopeChip, Data scopes
  section with a grant created, Users section scope column and edit dialog, a scoped
  user's landing, overview, organization (only their LOB), users page, platform page, the
  no_scope empty state, the data quality evidence gate; zero console errors; ASCII scan.
- live: pm2 aixp-dashboard restarted; as admin create the LOB manager role, a local user
  with it and one LOB grant, sign in as that user on localhost:3090 and confirm the
  figures match the admin's Organization row for that LOB; commit on dev; push.

## 16. Vendor connectors: framework, Anthropic Enterprise, org correlation (addendum 2026-11-04, builders M connector backend, N org correlation backend, O frontend)

Purpose (Doug, 2026-11-04): the CSV-to-Power-BI path is manual; CG wants near-real-time
usage with no manual pulls, pulled from each vendor's API. The connectors replace that path
over time; the Power BI connector stays until each vendor reconciles. Vendor org fields are
wanted and must map to CG LOB-CG values with a method that tolerates spelling differences.
Built BLIND: no key exists yet; the Test connection checklist is the fix loop on the first
real key. Research with every endpoint, parameter and field (URLs and read dates) is in
C:\Users\Dougl\.claude\skills\aixp-vendor-pull-plan\references\anthropic.md; builder M reads
it before writing the client. This round covers the framework, the Anthropic Enterprise
connector and the org correlation layer. GitHub, OpenAI and Microsoft are later rounds that
plug into the same framework.

### 16.1 Connector framework (backend/src/services/connectors/, owner M)

connectors/index.js is a registry: list() -> [{id, label, platform, enabled, configured,
problems}], get(id). A connector module exports:
- id ('anthropic'), label ('Anthropic Claude Enterprise'), platform ('anthropic', the
  PLATFORMS id its usage rows carry), describe() -> {fields, limits, lag, history_floor},
- problems() -> [missing config names] (empty = configured),
- test() -> {ok, duration_ms, steps: [{key, ok, label, detail}]} never throws on
  configuration (first step fails with the reason), same shape the Power BI test renders,
- pull({from, to, log, progress}) -> {usage: [rows in primer column names], detail:
  [rows for vendor_usage_detail], orgs: {values: [{value, people: [{person_key, email,
  display_name}]}]}, coverage: {org_total_usd, user_rows_usd, data_refreshed_at}}.

services/vendorImport.js runs ONE pull for every enabled connector into ONE dataset,
mirroring powerbiImport.pull: refuse 409 while a Power BI or vendor pull runs (shared
running flag in a tiny services/importLock.js both importers use); create the dataset
(source 'import', options {provider: 'vendor', connectors: [ids], from, to, asOf});
progress events import.progress gain {vendor} (stages auth|usage|carry|people|lookups|
normalize|verify|promote|done|error); for each connector pull its window and stage its
usage rows; CARRY-OVER: platforms with no enabled connector copy their usage rows from the
ACTIVE dataset's normalized usage table back into primer columns (Date, PersonKey,
Platform, Model, Tokens, Credits, Consumption, ConsumptionUnit, CostUSD, Requests,
discount_amount, net_amount) so GitHub, OpenAI and Cowork keep their last CSV rows until
their connectors exist; people and the three lookups are copied from the active dataset
exactly like powerbiImport.activeCopy (shared helper moved to services/activeCopy.js and
used by both importers); then staging.loadTables, normalize, verify, promote by
vendors.auto_promote, purge; vendors.last_pull_at and vendors.last_pull {dataset_id,
verdict, rows, duration_ms, error, by_vendor: {id: {rows, usd, from, to,
data_refreshed_at, coverage}}} saved and broadcast like Power BI. A connector that throws
fails the whole pull (dataset marked failed with the vendor name in the note), no partial
promote.

Window: from = max(connector history_floor, first day of the month months_back months
before today) when the active dataset has no rows from this provider for the platform,
else max(history_floor, last pulled day - rebuild_days); to = now. Idempotence comes from
the dataset model (a pull is a new dataset; carry-over copies unchanged platforms), so
re-pulling the trailing window simply replaces those days for that platform.

Schedule: services/vendorSchedule.js is powerbiSchedule.js generalised (same tick,
catch-up and nextRunAt logic) reading vendors.schedule and vendors.last_pull_at; refactor
powerbiSchedule to share the helpers (one file services/dailySchedule.js with
makeSchedule({enabledKey, scheduleKey, lastKey, run})) rather than copy. Both start in
server.js.

Settings keys (defaults.js, validators): vendors.schedule '' | 'HH:MM', vendors.auto_promote
true, vendors.months_back 13, vendors.last_pull_at, vendors.last_pull. Per connector:
anthropic.enabled false, anthropic.api_key SECRET (add to SECRET_KEYS; GET /api/settings
masks as {set}; '' keeps, null clears), anthropic.base_url 'https://api.anthropic.com'
(validator: http(s) URL, trailing slash trimmed; exists so tests and a proxy can point it
elsewhere), anthropic.anthropic_version '2026-10-21', anthropic.rebuild_days 9 (1..31),
anthropic.history_floor '2026-01-01' (read-only in the UI, from describe()).

Routes (routes/vendors.js, mounted at /api/vendors, data.manage like /powerbi):
GET /api/vendors -> {connectors: list(), schedule, auto_promote, months_back, running,
last_pull_at, last_pull, next_run_at}
POST /api/vendors/:id/test -> the checklist
POST /api/vendors/pull {ids?: [..], promote?: bool} -> {dataset_id, verdict, promoted,
rows, duration_ms, by_vendor}; 409 while running; 400 when no enabled connector
GET /api/vendors/detail?vendor=anthropic&from=&to=&person_key=&product= -> {rows} from
vendor_usage_detail (people.view required: add the rule GET /vendors/detail -> people.view
before the data.manage rule for /vendors)

Table vendor_usage_detail (db.js, M's region): vendor, date, person_key, email, model,
product, tokens REAL, cost_usd REAL, list_cost_usd REAL, requests INTEGER, pulled_at,
PRIMARY KEY (vendor, date, person_key, model, product). Upserted by every pull for its
window; this keeps the product breakdown the usage grain cannot hold (16.2). Not
dataset-bound. Scope rule: the detail route applies scope.peopleWhere through a join to
the active dataset's people like /users does (a scoped caller sees only their LOB).

### 16.2 Anthropic Enterprise connector (connectors/anthropic.js + anthropicClient.js, owner M)

Facts (binding, from the research): base https://api.anthropic.com, header x-api-key =
the Analytics key (prefix sk-ant-api01-, scope read:analytics, created by the Enterprise
primary owner at claude.ai > Organization settings > API), anthropic-version header,
anthropic-beta: analytics-usage-cost-2026-08-24 on /analytics/cost and /analytics/usage.
GET /v1/organizations/analytics/cost and GET /v1/organizations/analytics/usage with
starting_at (RFC 3339 inclusive, on or after 2026-01-01, within 365 days), ending_at
(exclusive, max span 31 days), time_bucket_width=1d, group_by[]=actor, group_by[]=model,
group_by[]=product, actor_types[]=user_actor, limit=1000, page=<next_page>. Envelope
{data, has_more, next_page, data_refreshed_at}. Cost row: starting_at, ending_at, group
{actor {type, user_id, email_address, name, deleted}, model, product}, cost {amount,
list_amount (decimal strings in FRACTIONAL CENTS, divide by 100 for USD), currency,
requests}. Usage row: same keys, usage {uncached_input_tokens, cache_creation {...},
cache_read_input_tokens, output_tokens, total_tokens, requests}. Product values: chat,
chat_cowork_unified, claude_code, cowork, office_agent, claude_in_chrome, claude_design,
claude_tag (response may spell claude-tag; normalise to underscore), other. Cursor rules:
page must keep every other parameter; 410 means the cursor expired, restart that window
from page one; 429 and 5xx retry three times with backoff; 401/403 stop with the body's
error message. Rate limit 60 requests a minute per organization: pace calls at least
1,000 ms apart. Lag: data_refreshed_at is the watermark (typically 4 h, up to 24 h);
values revise until about 7 days after month end, hence rebuild_days 9. Groups: GET
/v1/organizations/rbac_groups (scope read:rbac_groups, may be refused: then the step
reports it and orgs are skipped) -> {data: [{id, name, source_type}]} and GET
/v1/organizations/rbac_groups/{id}/members -> members with user ids and emails (shape
UNVERIFIED: read user_id, email_address, name defensively, log the first raw member
object once at debug). Org total: one unbucketed cost call for the window with NO group_by
gives the organization total for the coverage figure.

pull(): walk the window in 31-day slices; for each slice page /cost and /usage; join on
(UTC day of starting_at, actor.user_id, model, product); SUM across product into the
usage row grain (Date, PersonKey, Platform, Model) because the app's grain has no product
column and the duplicate check would fail otherwise; keep the per-product rows for
vendor_usage_detail. Row mapping: Date = YYYY-MM-DD of starting_at (UTC); PersonKey =
email_address lowercased and trimmed, else "user:<user_id>" (flagged in the pull log,
lands in Unmatched unless the People table carries that key); email = email_address;
Platform = 'anthropic'; Model = group.model or 'unattributed' when null; Tokens =
total_tokens; CostUSD = amount / 100; extra column ListCostUSD = list_amount / 100 (goes
to stage extra_json); Requests = usage.requests; Credits blank; ConsumptionUnit 'tokens'.
Rows whose actor is null are kept with PersonKey 'anthropic:unattributed'. orgs = each
rbac group as a value with its members. coverage = {org_total_usd, user_rows_usd,
data_refreshed_at}.

test(): steps auth (GET /v1/organizations/rbac_groups or a one-day /analytics/cost call
answers 200; 401/403 detail quotes the error), cost (first page of /analytics/cost for
yesterday with the beta header; detail = rows and data_refreshed_at), usage (same for
/analytics/usage), groups (count, or "read:rbac_groups not granted, org mapping skipped"),
freshness (data_refreshed_at age in hours, ok under 24), floor (history_floor and the
computed window). 200 even on failure.

### 16.3 Verification additions (services/verify/, owner M for the first, N for the others)

- vendor_coverage (info, platform anthropic): user rows USD vs organization total USD per
  pull; message "User-attributed rows cover X% of the organization total"; evidence the
  by_vendor coverage. Runs only on datasets with provider 'vendor'.
- vendor_org_unmatched (warn): vendor org values with people and no LOB mapping; evidence
  value, vendor, people count, suggestions.
- vendor_org_disagreement (info): people from the extract whose vendor org maps to a
  different LOB-CG than the extract says; evidence person_key, extract LOB, vendor org,
  mapped LOB. Never changes the extract's value.

### 16.4 Org correlation (services/orgCorrelation.js, routes/vendorOrgs.js, owner N)

Tables (db.js, N's region):
- vendor_org_values: id, vendor, value (as received), normalized, lob_cg (NULL = unmapped),
  match_method ('exact' | 'normalized' | 'alias' | 'fuzzy_confirmed' | 'manual' | NULL),
  score REAL, confirmed_by (users.id), confirmed_at, first_seen_at, last_seen_at,
  people_count, UNIQUE(vendor, value).
- vendor_org_aliases: id, alias (normalized form), lob_cg, created_by, created_at,
  UNIQUE(alias).
- vendor_org_people: vendor, person_key, email, display_name, value, seen_at, PRIMARY KEY
  (vendor, person_key, value). A person may sit in several vendor groups (Anthropic
  any-membership); when they map to different LOBs the FIRST mapped value by
  lob_cg_sort wins and the row is listed under disagreement.
- people gains origin TEXT NOT NULL DEFAULT 'extract' ('extract' | 'vendor') through the
  guarded ALTER list in db.js.

normalizeOrg(s): lowercase, trim, collapse whitespace, strip punctuation except spaces,
drop filler tokens (the, and, of, dept, department, team, org, organisation,
organization, group, lob, line of business, cg), collapse spaces again. Exposed and
unit-tested.

matchValue(vendor, value): order exact (value equals a current lob_cg label of the active
dataset), normalized (normalizeOrg equal), alias (vendor_org_aliases by normalized),
else fuzzy suggestions: score = max(tokenSetRatio, jaroWinkler) over the normalized
forms of every active lob_cg label (both implemented in the service, no dependency;
tokenSetRatio = 2 x shared tokens / (tokens a + tokens b); Jaro-Winkler standard with
prefix scale 0.1); suggestions with score >= 0.80 sorted desc, top 3, NEVER auto-applied.
A confirmed or manual mapping is kept across pulls; a value whose mapping method is exact
or normalized is re-evaluated on every pull (a renamed label is caught), alias and
confirmed ones are not.

ingest(vendor, orgs, now): upsert vendor_org_values (first_seen, last_seen, people_count,
run matchValue for rows without a kept mapping), replace vendor_org_people for that
vendor. Called by vendorImport after each connector pull, before normalize.

applyToDataset(datasetId): for every usage person_key in the dataset with NO people row
and with a vendor_org_people row whose value has a lob_cg: INSERT a people row (person_key,
email, display_name from the vendor, lob_cg, lob_cg_sort of that label from the dataset's
existing people or lob_cg_map, region 'Unknown', sbl 'Unknown', person_type 'Unknown',
origin 'vendor'), then set usage.matched for those keys. People rows from the extract are
NEVER changed. normalize() calls applyToDataset at its end (no-op when the tables are
empty, so fixtures are unaffected). datasets.get counts gain people_vendor.

Routes (routes/vendorOrgs.js mounted at /api/vendor-orgs, settings.manage like
/settings/lob-cg-map):
GET /api/vendor-orgs?vendor= -> {rows: [{id, vendor, value, normalized, lob_cg,
match_method, score, people_count, suggestions: [{lob_cg, score}], confirmed_by:
{id, username} or null, last_seen_at}], lob_values: [{value, sort}], aliases: [{id, alias,
lob_cg}], counts: {mapped, unmatched, people_unmatched}}
PUT /api/vendor-orgs/:id {lob_cg: string | null, method?: 'fuzzy_confirmed' | 'manual'}
-> row; null clears to unmapped (and re-evaluates exact/normalized next pull); a lob_cg
not in the active dataset answers 400
POST /api/vendor-orgs/aliases {alias, lob_cg} -> row (alias stored normalized; 409 dup)
DELETE /api/vendor-orgs/aliases/:id
GET /api/vendor-orgs/:id/people -> {rows: [{person_key, email, display_name, in_extract:
bool, extract_lob_cg}]}
POST /api/vendor-orgs/apply -> re-runs matchValue on unmapped rows and applyToDataset on
the active dataset, rebuilds rollups (rollups.rebuildOrg), -> counts
GET /api/vendor-orgs/export.csv
Every mutation writes auth_events kind org_map_changed (detail: vendor, value, lob_cg,
method) and broadcasts settings.changed {keys: ['vendor_orgs']}.

### 16.5 Frontend (owner O)

- Settings > Data source: a "Vendor connectors" panel under the Power BI panel: intro line
  ("Pull usage straight from each vendor. Platforms without a connector keep the rows from
  the last Power BI or CSV load."), shared controls (schedule time, auto promote, months
  back, Pull now for every enabled connector with the same progress panel as Power BI,
  now showing the vendor chip per event, last pull summary with the by_vendor table), then
  one ConnectorCard per connector from GET /api/vendors: enabled toggle, status chip
  (Not configured | Ready | Last pull ok | Last pull failed), fields from the contract
  (Anthropic: API key SecretField, re-pull days, Advanced fold with base URL and version,
  read-only history floor line "Data is available from 2026-01-01"), Test connection
  (checklist rows like the Power BI one), Pull this connector only. Help text in two
  sentences: who creates the Analytics key and where, and that the key needs
  read:analytics (read:rbac_groups adds team mapping).
- Settings > LOB-CG map: a second SectionCard "Vendor orgs" under the map: vendor filter
  chips, counts line (mapped, unmatched, people without a LOB that a mapping would fix),
  DataTable rows (vendor, value, people, mapping: a select of lob_values with the current
  value, suggestion chips "Technology 0.91" that set the select, method chip, confirmed
  by, last seen), Save per row (PUT), Clear, an Aliases fold (list, add alias -> LOB,
  remove), "Apply mappings now" button (POST apply, toast with counts), CSV export.
  People link opens a small Drawer listing the people behind a value with an
  "in extract" chip and the extract LOB when different.
- Data quality: the three new checks render like any other; evidence drawer unchanged.
- Users page and User drawer: a person with origin 'vendor' shows a muted "LOB from
  vendor org" chip (API: /api/users rows and userDetail carry origin).
- Mocks: vendors.json, vendors-test.json, vendor-orgs.json, vendor-orgs-people.json.

### 16.6 Tests and definition of done

- tests/connectors.anthropic.test.js (M): a fake Anthropic server (express on port 0)
  serving /v1/organizations/analytics/cost and /usage from a generated set of users,
  models, products and days with limit paging, the 31-day and 2026-01-01 constraints
  (400), one 410 on a replayed cursor, one 429, data_refreshed_at, rbac_groups and members;
  asserts: problems() and test() steps on a missing key, 401 and a good key; pull window
  slicing and pacing (calls at least 1,000 ms apart, faked clock allowed); join and
  product summing (sum of CostUSD equals sum of amounts / 100, tokens equal); deleted user
  fallback key; unattributed row; vendor_usage_detail rows per product; coverage figure;
  end to end pull into a dataset with carry-over of the other platforms from the active
  fixture (counts per platform equal the fixture's for github, openai, cowork), verdict,
  promote; a second pull with the trailing window gives the same totals; 409 while
  running; failure marks the dataset failed.
- tests/orgCorrelation.test.js (N): normalizeOrg cases (TECH2, "Technology - Dept",
  "Investment  Group (IG)"), exact/normalized/alias/fuzzy order, suggestions sorted with
  scores and the 0.80 threshold, confirm and clear, ingest upsert and people replace,
  applyToDataset creates vendor-origin people only for unmatched keys and never touches
  extract rows, disagreement and unmatched checks, routes (settings.manage gate, 400 on an
  unknown LOB, CSV), auth_events row.
- Existing suites green; smoke-shapes gains /api/vendors, /api/vendor-orgs rows.
- Frontend build green; screenshot QA light and dark of the connector panel (not
  configured, after a failed test against a dead base URL, mocked ok), the progress
  panel, the Vendor orgs section with suggestions and an alias; zero console errors; ASCII.
- Live: pm2 restart; Settings shows the panel; Test connection against the real endpoint
  with no key answers the first step failed with the vendor's error text. Nothing else can
  be proven without a key; the fake server suite is the proof and the first real key is
  the fix loop.

## 17. Integration help: URLs, ports and permissions per platform (addendum 2026-11-04, builder P)

Purpose (Doug): a help page or section per integration that states the URLs, ports and
permissions it needs, so the CG teams who request keys and open firewalls have one place
to read from.

Source of truth: backend/src/services/integrationHelp.js (written by Fable, static, ASCII;
builders do not edit its content). Each entry: {id, name, status 'built' | 'planned', kind
'source' | 'identity' | 'vendor', summary, urls: [{label, value}], ports (string),
credentials: [string], permissions: [string], limits: [string], where (string), notes:
[string]}. Entries today: powerbi, ad, anthropic (built), github, openai, cowork (planned).

Backend (owner P): GET /api/help/integrations -> {rows: integrationHelp.list()} and GET
/api/help/integrations/:id -> one entry or 404. Rule in auth.js: GET /help... needs
dashboard.view (every signed-in data user may read it; settings users without
dashboard.view get it too, so the rule is: any authenticated user; add it as a keys: []
rule that still requires a session, placed before the default). Test tests/help.test.js:
both routes answer for a Viewer, 401 signed out, every entry ASCII, every entry has the
keys above, ids unique, the three built ids match the connector registry plus powerbi and
ad. docs/API.md rows.

Frontend (owner P):
- Page /help (pages/HelpPage.jsx): PageHeader "Integration requirements" with the line
  "What each integration needs before it can connect: addresses, ports, credentials and
  the permissions behind them. Planned connectors show what the research found."; filter
  chips All | Built | Planned; one Card per entry with the status chip (Built | Planned),
  kind chip, summary, then labelled blocks: Addresses (two-column table label/value, values
  in a monospace span that wraps), Network (ports text), Credentials (list), Permissions
  (list), Limits (list), Where in the app, Notes. A "Copy as text" button per card puts a
  plain ASCII rendering of that card on the clipboard (for a firewall or access request
  email). Anchors #<id> so links from settings land on the card.
- Nav: a "Help" link beside Settings in the account area (every signed-in user), and the
  Footer gains Help.
- Settings: the Anthropic connector card, the Power BI panel and the Active Directory
  section each gain a "Requirements" fold (collapsed) that renders the same blocks for its
  entry from GET /api/help/integrations/:id, plus a "Open help" link to /help#<id>.
- Mocks: help-integrations.json (copy of the catalogue through the API shape).
- Build green, ASCII scan, screenshots light and dark of the Help page (filtered to
  Planned too), one Requirements fold open on the Anthropic card.
