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
