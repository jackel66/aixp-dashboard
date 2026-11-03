# AIxP Dashboard API

All routes live under /api and answer JSON. Response shapes are fixed in
docs/CONTRACT.md section 8; this file is the route table and is kept current by
builder B as routes land. Every error is {error: "message"} with an HTTP status.

## Notes and decisions

- Seat spend over a window is each month's rate x seats prorated by the days of that month
  inside the window, so whole months tie exactly to seat_rate. With spend.seat_basis = active,
  seats are the distinct active people of the month in rollup_person_month and the summary
  carries seat: {basis, estimate: true}.
- /api/summary: platforms and totals cover range (default the 90 days to asOf). headline is
  month to date for the month of range.to against the previous month's same days; with an
  explicit from or to it is that window against the equal-length window before it.
- /api/trend with no from: day 90 days, week the 12 weeks before the week of "to" plus that week,
  month 12 months. Buckets with no data are returned as zeros. Week labels read "27 Oct".
- /api/organization row keys are slugs of the label (gbs-l-c), plus __unassigned__ (sort 998) and
  __unmatched__ (sort 999, always last). Seat and total basis allocate seat spend to matched rows
  by share of active people per month; seat for months with no matched actives lands on
  __unassigned__. Active users per cell are distinct over the whole range.
- Reads: report queries use rollup_* tables. Exceptions: users per model and model top users
  (usage), GitHub gross/discount/net (usage), user detail model split and activity (usage).
- A dataset with no rollups answers 409; no active dataset answers 404.
- GET /api/verification returns run: null and every check as status skip until a run exists.
- POST /api/fixtures/generate defaults promote to true and promotes with force; it also stores
  the options in fixture.options. Events: fixture.generated, then dataset.promoted.

- Money travels as {usd, basis}; consumption as {value, unit}. Tokens and credits are
  never summed across platforms.
- Default range: the 90 days ending at the active dataset's overall max date.
- Every response carries asOf (the dataset's overall max date).
- CSV exports begin with "# " + the standing caveat.

## Health and auth

| Method | Path | Notes |
|---|---|---|
| GET | /api/health | ok, version, buildId, active dataset id and counts |
| GET | /api/events | server-sent events: hello, ping, dataset.promoted, dataset.verified, settings.changed, fixture.generated |
| POST | /api/auth/login | {password} when APP_PASSWORD is set |
| GET | /api/auth/session | {required, authenticated} |
| POST | /api/auth/logout | |

## Reports

| Method | Path | Params |
|---|---|---|
| GET | /api/summary | dataset, basis |
| GET | /api/trend | grain=day,week,month; from, to, platform, basis |
| GET | /api/platforms/:id | from, to, basis |
| GET | /api/organization | dim=lob_cg,region,sbl,person_type; measure=spend,users,units; from, to, platform, basis |
| GET | /api/organization/cell | dim, key, platform, from, to |
| GET | /api/models | from, to, platform |
| GET | /api/models/:platform/:model | from, to |
| GET | /api/users | q, sort=usd,name,lob_cg,active_days, dir, page, pageSize (max 200), platform, lob_cg, region, sbl, person_type (exact label match), from, to |
| GET | /api/users/:personKey | from, to |

## Verification and datasets

| Method | Path | Notes |
|---|---|---|
| GET | /api/verification | latest run of the dataset, checks without evidence |
| GET | /api/verification/runs/:runId | run with evidence |
| GET | /api/verification/runs/:runId/checks/:checkId | one check with evidence and history; platform= for scoped checks |
| GET | /api/datasets | list with per-platform rows |
| GET | /api/datasets/:id | |
| POST | /api/datasets/:id/verify | |
| POST | /api/datasets/:id/promote | {force}; 409 when verdict fail without force |
| POST | /api/datasets/rollback | {to} |
| POST | /api/fixtures/generate | {seed, months, people, profile, defects, promote} |

## Settings and export

| Method | Path | Notes |
|---|---|---|
| GET | /api/settings | |
| PUT | /api/settings | patch of keys (CONTRACT section 4) |
| GET | /api/settings/seat-rates | active dataset rows |
| PUT | /api/settings/seat-rates | {rows} |
| GET | /api/settings/lob-cg-map | |
| PUT | /api/settings/lob-cg-map | {rows}; rebuilds people.lob_cg and rollup_org_month |
| GET | /api/export/:report.csv | report = summary, trend, platform (needs platform=<id>), organization, models, users; first line is "# " + caveat; text cells starting with = + - @ get a leading apostrophe; consumption always has a unit column |

## Reports

| Method | Path | Notes |
|---|---|---|
| GET | /api/reports | catalogue: {groups: [{id, title}], reports: [{id, group, title, description, params, columns: [{key, label, type}]}]}; 17 reports in groups users, platforms, models, costs |
| GET | /api/reports/:id | query from, to, platform (repeatable), basis, dim (lob_cg, region, sbl, person_type), limit (1 to 500, default 50); only the params a report lists apply. Returns {id, title, description, asOf, range, params, columns, rows, totals, chart, notes}; 404 unknown id, 400 bad params |
| GET | /api/export/report/:id.csv | same params; first line is "# " + caveat; units columns become <key> and <key>_unit, delta columns become <key>_now, _prev, _delta, _pct; the totals row is appended last |

Value conventions: money is USD numbers, pct is a percent number (11.3 = 11.3 percent, also delta.pct), units is {value, unit}, delta is {now, prev, delta, pct}. totals, when present, is row shaped (keyed by column key, first text column holds the label). User reports carry an extra person_key on every row (not a column). models_adoption (keys week, u_0..u_7) and models_by_group (group, usd_0..usd_7, total) return the model columns in the response columns; the catalogue lists the fixed ones only. A one-day range (from == to) is valid on every route and report; the previous window is the previous day.

## Running

    cd backend && npm install && npm start            # port 3090
    node scripts/gen-fixture.js --seed-db --profile clean
    npm test

## Power BI connector (CONTRACT section 13)

Settings keys powerbi.* are read and written through /api/settings. powerbi.client_secret and
powerbi.token are write-only: GET returns {set: true|false}; PUT with a string stores it
encrypted (AES-256-GCM), with '' or the masked object keeps the stored value, with null clears it.
Upstream failures (Azure AD, Power BI) answer 502 with the Power BI error text; secrets are redacted.
Dataset rows (list, by id, summary.dataset) carry provider ('fixture' | 'powerbi' | 'import') and
options as a parsed object.

| Method | Path | Notes |
|---|---|---|
| POST | /api/powerbi/test | {ok, auth: {ok, expires_in, error?}, workspace: {ok, name?, error?}, dataset: {ok, name?, error?}, tables: [{key, name, ok, rows? \| error? \| skipped?}], latest: {usage_max_date}}; 200 even when ok is false |
| GET | /api/powerbi/datasets | [{id, name}] for the configured workspace; 502 on upstream failure |
| POST | /api/powerbi/pull | body {} (optional {promote: bool}); {dataset_id, verdict, promoted, rows, duration_ms}; 400 not configured, 409 already running, 502 upstream; broadcasts import.progress |
| GET | /api/powerbi/status | {configured, enabled, running, last_pull_at, last_pull, schedule, next_run_at} |

SSE import.progress: {stage: auth\|usage\|people\|lookups\|normalize\|verify\|promote\|done\|error, table, chunk, rows, message}.
A pull always ends with stage done (rows = usage rows) or stage error (message).
Environment: AIXP_SECRET_KEY (32 bytes, hex or base64) else a key file beside the database
(backend/data/.secret-key); POWERBI_LOGIN_URL and POWERBI_API_URL override the Azure AD and Power BI hosts (tests).
