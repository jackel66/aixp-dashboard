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

## Running

    cd backend && npm install && npm start            # port 3090
    node scripts/gen-fixture.js --seed-db --profile clean
    npm test
