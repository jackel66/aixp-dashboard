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
| GET | /api/events | server-sent events: hello, ping, dataset.promoted, dataset.verified, settings.changed, fixture.generated, access.changed {what: users, roles, assignments, directory}; needs a session (dashboard.view) |
| POST | /api/auth/login | {username, password}; see "Access and sign-in" below. APP_PASSWORD is ignored. |
| GET | /api/auth/session | {authenticated, user, permissions, roles, ad} or {authenticated: false, ad} |
| POST | /api/auth/logout | |
| POST | /api/auth/change-password | {current_password, new_password} |

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

## Access and sign-in (CONTRACT section 14)

Every /api route except GET /api/health and /api/auth/* needs a session cookie (aixp_session, HttpOnly, SameSite=Lax,
7 days absolute, 12 hours idle). Every non-GET request, login included, must carry the header `x-aixp-csrf: 1`, else
403 {error: "Missing request header", code: "csrf"}. A missing session answers 401 {error: "Sign in required"}. A refused
permission answers 403 {error: "You do not have permission to <verb>", required: "<key>"}.

Permission catalogue: dashboard.view, people.view, export.csv, data.manage, settings.manage, access.manage.
System roles (read-only): Administrator (all), Executive (dashboard.view, export.csv), Analyst (dashboard.view,
people.view, export.csv), Viewer (dashboard.view). A user's permissions are the union of the roles assigned to the user,
to an AD group the user belongs to (DN or SID, nested and primary group included) and to an AD OU the user sits under
(DN suffix at a comma boundary). First boot seeds admin / M0nkside (default_password 1 until its password changes).

Enforcement table (first match wins, in backend/src/auth.js):

| Request | Needs |
|---|---|
| GET /api/health, /api/auth/* | nothing (the csrf header is still required on non-GET) |
| GET /api/events | dashboard.view |
| /api/access/* | access.manage |
| /api/settings, /api/settings/* | settings.manage |
| GET /api/datasets | dashboard.view |
| POST, PUT, DELETE /api/datasets/* | data.manage |
| /api/fixtures/*, /api/powerbi/* | data.manage |
| /api/users, /api/users/* | people.view |
| GET /api/export/users.csv, /api/export/report/users_*.csv | people.view and export.csv |
| /api/export/* | export.csv |
| /api/reports/users_* | people.view |
| everything else | dashboard.view |

POST /api/auth/login {username, password}. The username is trimmed and lowercased; DOMAIN\name and name@domain are domain
qualified; a bare name is local first, then domain when AD is enabled and no active local user has the name.

| Status | Body | When |
|---|---|---|
| 200 | session body | signed in; sets the cookie |
| 400 | {error, code: "missing"} | username or password empty |
| 401 | {error: "Wrong username or password", code: "bad_credentials"} | unknown, disabled or wrong |
| 401 | {error: "This domain account is disabled.", code: "ad_disabled"} | disabled in AD |
| 403 | {error: "This account has no role. Ask an administrator.", code: "no_role"} | local user without any role |
| 403 | {error: "Your domain account signed in but no AIxP role is assigned to you, your groups or your organizational unit. Ask an administrator.", code: "no_role"} | AD user without any role |
| 423 | {error: "Too many failed sign-ins. Try again in N minutes.", code: "locked"} | local: 5 failures in 10 minutes lock 15 minutes (the 5th failure itself still answers 401); AD: 3 failures in 10 minutes pause that name for 10 minutes |
| 503 | {error, code: "ad_unreachable", detail: [attempt lines]} | domain controllers unreachable or the service account failing; local sign-in still works |

Session body: {authenticated: true, user: {id, username, display_name, email, source, default_password, person_key, ad_ou, ad_attrs},
permissions: [keys], roles: [{id, name}], ad: {enabled, domain}}. POST /api/auth/change-password answers 400 when the current
password is wrong or the new one is not 10 to 128 characters ("Password must be 10 to 128 characters."); AD users get 400 "Domain
passwords are changed in Active Directory, not here."; the current session stays and the user's other sessions are dropped.

Access routes (all need access.manage). Flags (active, default_password, system) are 1 or 0.

| Method | Path | Body and answer |
|---|---|---|
| GET | /api/access/permissions | [{key, label, description}] |
| GET | /api/access/users | {rows: [{id, username, display_name, email, source, active, default_password, last_login_at, created_at, locked_until, roles: [{id, name, via}], ad_ou, ad_attrs, person_key}]}; via is direct, group:NAME or ou:NAME |
| POST | /api/access/users | {username, display_name, email, password, role_ids} -> 201 user row; 409 taken name; 400 password rule (a local username is 1 to 64 of a-z 0-9 . _ -) |
| POST | /api/access/users/ad | {dn} -> 201 user row; 404 not in the directory; 409 already added; 400 AD not enabled; 503 unreachable |
| PUT | /api/access/users/:id | {display_name, email, active, role_ids}; role_ids replaces direct assignments; AD users take active and role_ids only; 400 for self-disable and for the last active administrator (disable, or losing the Administrator role) |
| PUT | /api/access/users/:id/password | {password} -> {ok}; drops that user's sessions; 400 for an AD user |
| DELETE | /api/access/users/:id | {ok}; 400 for self and for the last active administrator |
| GET | /api/access/roles | {rows: [{id, name, description, system, permissions, user_count, group_count, ou_count}]}, system roles first |
| POST | /api/access/roles | {name, description, permissions} -> 201; 409 duplicate name (case-insensitive); 400 name length or permissions |
| PUT | /api/access/roles/:id | same fields; 400 "System roles cannot be edited" |
| DELETE | /api/access/roles/:id | {ok}; removes its assignments; 400 for a system role |
| GET | /api/access/roles/:id/assignments | {rows: [{id, subject_type, user: {id, username, display_name, source} or null, ad_dn, ad_sid, ad_name, created_at}]} |
| POST | /api/access/roles/:id/assignments | {subject_type: "user", user_id} or {subject_type: "ad_group" or "ad_ou", ad_dn, ad_sid, ad_name} -> 201; 409 duplicate; 400 when AD is not enabled |
| DELETE | /api/access/roles/:id/assignments/:aid | {ok}; 400 when it would remove the last active administrator |
| GET | /api/access/directory | {config, discovered: {servers, base_dn, url, at, error}, status: {last_test_at, last_test_ok, last_test, last_sync_at, last_sync}, user_count}; config is keyed by the full setting names: ad.enabled, ad.domain, ad.bind_user, ad.bind_password as {set}, ad.servers, ad.base_dn, ad.tls_mode, ad.tls_verify, ad.ca_cert, ad.sync_minutes, ad.deactivate_removed |
| PUT | /api/access/directory | {patch: {"ad.domain": ...}} or the keys directly; answers at once with the GET body and runs discovery in the background; ad.bind_password: "" keeps the stored one, null clears it |
| POST | /api/access/directory/test | {ok, duration_ms, steps: [{key, ok, label, detail, skipped?}]}; keys dns, connect, bind, base_dn, users, groups, ous; 200 even when a step fails (later steps are marked skipped) |
| GET | /api/access/directory/search?type=user,group,ou&q= | {rows: [{type, ...}]}, up to 50 per type; user {dn, sam, upn, display_name, email, disabled, ou}, group {dn, name, sid, description}, ou {dn, name, path}; 400 AD off; 503 unreachable |
| POST | /api/access/directory/sync | {users, updated, deactivated, errors: []}; also runs every ad.sync_minutes |
| GET | /api/access/events?limit=200&kind= | {rows: [{id, at, kind, username, user_id, source, ip, detail, actor_user_id}]}, newest first |

Directory settings (ad.*) are hidden from GET /api/settings and refused by PUT /api/settings with 400
"Directory settings are saved under /api/access/directory".
