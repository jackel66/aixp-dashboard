# AIxP Dashboard API

All routes live under /api and answer JSON. Response shapes are fixed in
docs/CONTRACT.md section 8; this file is the route table and is kept current by
builder B as routes land. Every error is {error: "message"} with an HTTP status.

## Notes and decisions

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
| GET | /api/users | q, sort, dir, page, pageSize, platform, lob_cg, region, from, to |
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
| GET | /api/export/:report.csv | report = summary, trend, platform, organization, models, users |

## Running

    cd backend && npm install && npm start            # port 3090
    node scripts/gen-fixture.js --seed-db --profile clean
    npm test
