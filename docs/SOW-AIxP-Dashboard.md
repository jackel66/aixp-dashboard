# Statement of work: AIxP Dashboard build

Client: Capital Group (CG)
Provider: Trace3, Financial Services Group
Prepared by: Doug Austin, Principal Solutions Architect
Version: 0.3 draft, 5 November 2026
Status: for review. Fees, payment terms and the engagement model are set out in the accompanying Trace3 order form, not in this document.

## 1. Background

Capital Group maintains an executive view of AI consumption and directional spend across Anthropic, OpenAI, GitHub Copilot and Microsoft Copilot Cowork. Today that view is the AI Platform Economics report in Power BI, fed by vendor CSV exports that are pulled by hand and loaded into a semantic model. The report supports the COO forum and related stakeholders. The SME onboarding guide dated 27 October 2026 describes it as a directional view, not an invoice, a budget reconciliation or a Finance expense system.

The manual export path has three costs. Data arrives days after the fact and only when someone runs the exports. Each vendor file carries its own grain, units and identity key, so the joins, normalisation rules and verification checks live in Power Query and DAX where few people can inspect them. And the validation steps the guide requires after every refresh are manual.

Capital Group now wants a dashboard with live statistics that shows AI cost back to business leaders by line of business, as close to real cost analysis as each vendor platform allows. That means pulling usage and cost directly from the vendor and internal platforms through their APIs, applying one documented set of attribution rules, verifying every load, and reconciling the result against vendor billing so the figures leaders see can be defended. The Power BI semantic model stays available as a comparison source during reconciliation.

## 2. Objectives

1. Show AI cost and consumption back to business leaders by line of business, platform, model and person, refreshed from the source platforms daily and more often where a platform allows it.
2. Get as close to billed cost as each platform permits: billed figures where the vendor exposes them, allocated figures where it does not, with every allocated figure labelled as such.
3. Cover the platforms in use: APEX (Capital Group internal tooling), Microsoft Copilot and Copilot Cowork, Anthropic, GitHub Copilot, AWS Bedrock, and OpenAI with ChatGPT Enterprise.
4. One documented set of normalisation, identity and attribution rules, applied in code and tested, matching the SME onboarding guide where it applies.
5. Every load verified before it is visible, with the evidence a reviewer needs when a check fails.
6. Access restricted by role and by line of business, with Active Directory sign-in and an audit trail, on infrastructure inside the Capital Group environment.

## 3. Scope of work

The engagement runs in six phases. Phases 1 and 2 are discovery and enablement with Capital Group's internal teams; phases 3 to 5 are build, remediation and reconciliation; phase 6 is handover. A working prototype of the dashboard and five vendor connectors was built ahead of this statement of work against generated sample data and vendor documentation; the build phase extends and hardens it rather than starting from nothing.

### 3.1 Phase 1: Discovery

One discovery track per platform, run with the Capital Group team that owns it:

- APEX. Establish what the internal tooling is, what usage and cost data it records (requests, tokens, model, caller, cost or internal rate), how it can be read (API, database, export) and who owns access. APEX is the one platform with no prior research; its integration design is a discovery output.
- Microsoft. Confirm the Copilot and Copilot Cowork licensing in place, which Graph reports and endpoints are available to the tenant, the application registration and consent path, and how per-user credits are exposed today (the beta balance endpoint, the credits report, or both).
- Anthropic. Confirm the Claude Enterprise organisation, who holds the primary owner role that can create an analytics key, the history available and the products in use (chat, Claude Code, Cowork).
- GitHub. Confirm the enterprise and organisations in scope, the billing platform in use, whether the Copilot usage metrics policy is enabled, and the token type the security team will permit.
- AWS Bedrock. Confirm the accounts and regions in scope, whether model invocation logging is enabled and since when, how principals call Bedrock (shared roles, per-user roles, Identity Center, API keys), and whether Cost Explorer resource and identity data are enabled.
- OpenAI and ChatGPT Enterprise. Confirm the organisation and workspace structure, admin key ownership, and which cost surfaces are in use (API platform, ChatGPT Enterprise credits, or both).

Cross-platform discovery: the identity model (the People extract, email and alias keys, Active Directory attributes) and how each platform's caller identity maps to a person; the showback model with business leaders (what a leader sees, how shared or unattributed cost is treated, seat versus consumption basis, the rate used for Microsoft credits); the environment (server, proxy, certificate authority, reverse proxy, Active Directory, egress rules). Discovery ends with a written report, an integration matrix per platform (data available, grain, identity key, lag, history floor, access path, owner), the access request list and the environment specification.

### 3.2 Phase 2: Access and environment

Working with Capital Group's internal teams to obtain API access on each platform (credentials, application registrations, IAM policies, consent), provision the server that runs the platform (Windows or Linux, sized from discovery), and open the network path: outbound access to the vendor hosts directly or through the corporate proxy with the corporate certificate authority, inbound access through a reverse proxy with a corporate TLS certificate, LDAPS to the domain controllers, and firewall rules for each. Trace3 writes the requests with the exact hosts, ports and permissions; Capital Group teams approve and implement them. The security review inputs the CG security team needs are prepared in this phase.

### 3.3 Phase 3: Design and development

Design: the showback views for business leaders, designed with them from the discovery outputs (line-of-business cost and trend, cost per person and per model, seat versus consumption, allocated versus billed, drill to the people and models behind a figure), together with the executive overview, platform pages, organisation matrix, models, users, data quality and reports pages already prototyped.

Development: extend the prototype to the agreed design; build the APEX connector; adapt the five vendor connectors to what discovery found; implement live statistics (daily pulls, intraday refresh where a platform's lag and limits allow it, freshness shown per platform); the cost model (billed figures where available, allocation rules where not, each figure labelled with its source); organisation correlation from vendor teams and groups to LOB-CG; roles, Active Directory sign-in and line-of-business data scopes; the security hardening items from the 5 November 2026 review; proxy and certificate support; installation on the CG server with a service definition and runbook.

### 3.4 Phase 4: Data gathering remediation

The first connection to each platform with real credentials is a fix loop: the connection test reports every step with the platform's own error text, response shapes are corrected, and gaps are closed with the platform owner (logging that is off, permissions missing, identities that do not resolve to a person, history that starts later than expected). Unmatched usage is driven down through the identity rules and organisation correlation, and what remains is reported, not hidden.

### 3.5 Phase 5: Metrics and cost reconciliation

For each platform: reconcile one closed day and one closed month to the platform's own reporting, compare the dashboard's totals against the vendor invoice or billing statement where Capital Group makes it available, and record each difference with its cause (timing, allocation, discounts, credits, items the API does not expose). Compare platform totals, active users, unmatched usage and latest available date against the Power BI report for identical selections. Confirm the seat rates, the Microsoft credit rate and the allocation rules with Finance and the business owners. Run the restricted-consumer access tests the guide requires. The output is a reconciliation report per platform with a stated confidence level and the remaining known gaps, signed off by the product owner.

### 3.6 Phase 6: Handover and support

Administrator and SME walkthroughs, the maintained documentation set (design contract, API reference, integration requirements, security review, reconciliation report, runbook), source code in a repository Capital Group designates, and a defined support window after go-live.

## 4. Deliverables

| ID | Deliverable | Phase | Acceptance |
|---|---|---|---|
| D1 | Discovery report and integration matrix | 1 | Covers every platform in section 2; access request list and environment specification issued |
| D2 | Access and environment in place | 2 | Credentials for each platform received; server reachable; network path proven by the connection tests |
| D3 | Showback design | 3 | Business leader views agreed in writing by the product owner |
| D4 | AIxP Dashboard application, source and build | 3 | Builds from source; automated test suite passes; every page renders |
| D5 | Platform connectors (APEX plus five vendors) | 3, 4 | Each connection test passes with CG credentials; one month pulled per platform with freshness, duplicate and attribution checks passing or explained |
| D6 | Identity, access and security | 3 | AD sign-in works for a named test group; scopes verified by restricted-consumer tests; review items closed with evidence |
| D7 | Installed production instance | 3 | Running on the CG server behind TLS, schedule active, runbook delivered |
| D8 | Reconciliation report | 5 | Per-platform differences explained with confidence levels; product owner sign-off |
| D9 | Documentation and handover | 6 | Document set delivered; walkthroughs held; support window started |

## 5. Out of scope

- Invoice processing, Finance expense reporting or budget control. The dashboard reconciles to billing as a check; it is not the system of record for spend.
- Changes to the Power BI semantic model, report or workspace, beyond read access for comparison.
- Vendor contracts, seat procurement, rate negotiation or pricing analysis.
- Changes to APEX or any vendor platform; the engagement reads from them.
- Platforms other than those named in section 2. Adding one is a change request.
- Single sign-on by SAML or OpenID Connect (Active Directory over LDAPS is in scope; federated SSO is a change request).
- Mobile applications, embedded AI assistants and natural-language query over the data.
- Hosting or operation of the application outside Capital Group infrastructure.

## 6. Assumptions and dependencies

1. Capital Group names an owner for each platform (APEX, Microsoft, Anthropic, GitHub, AWS, OpenAI), the identity data, the server, the network and security, and makes them available for discovery and for the access requests.
2. API access is possible on each platform. Where a platform exposes no API for a figure (today the Microsoft per-user credit balance is a beta endpoint with no history, and per-user Bedrock cost is an allocation), the dashboard uses the closest supported method and labels it; discovery records the limit.
3. Bedrock model invocation logging is enabled in the accounts and regions in scope; per-user Bedrock data begins on the day it was switched on.
4. Capital Group provides a server with outbound access to the platform hosts (direct or through the corporate proxy), a TLS certificate from the corporate PKI, a reverse proxy or permission to terminate TLS, a read-only Active Directory service account and a low-privilege service account to run the application.
5. A Power BI service principal, or a user able to issue a token, is permitted on the AI Platform Economics workspace for the comparison pulls.
6. The People extract and the LOB-CG and region mappings continue to be supplied by Capital Group.
7. Vendor invoices or billing statements are made available for the reconciliation month, or reconciliation is limited to the platforms' own reporting and the report says so.
8. Vendor API behaviour, limits and history floors are as documented by the vendors on 4 and 5 November 2026; changes during the engagement are handled under change control.

## 7. Responsibilities

| Trace3 | Capital Group |
|---|---|
| Run discovery and write the report, integration matrix, access requests and environment specification | Provide platform owners, SMEs and business leaders for discovery and design |
| Design the showback views with business leaders | Approve the design and the allocation rules |
| Build, test and document the application and connectors | Obtain credentials, registrations and IAM policies through internal teams |
| Write the server, network and firewall requests | Provision the server and implement network and firewall changes |
| Run the fix loops and remediation with each platform owner | Enable logging and permissions each platform needs |
| Run the reconciliation and write the report | Provide invoices or billing statements; confirm rates; give sign-off |
| Install, configure and verify the production instance | Operate the application after handover |
| Hold the walkthroughs; support during the defined window | Attend walkthroughs; own the application afterwards |

## 8. Approach, timeline and effort

The target is two months from kick-off to handover. Three months is the outer bound. The gap between the two is almost entirely work outside this team's direct control: credential and permission requests through Capital Group's internal teams, server provisioning, firewall and proxy changes, and the APEX integration path, which is unknown until discovery. The plan below is written conservatively for that reason: the hours carry a range, the schedule shows the eight-week plan and what pushes it to twelve, and reconciliation is scoped to the closed month the data allows rather than a fixed calendar month.

### 8.1 Effort estimate by phase

Hours are Trace3 effort estimates for planning and staffing. They are not fees; fees and the engagement model are in the order form. The low figure assumes access arrives on time and the platforms behave as documented. The high figure allows for a fix loop on every platform, an APEX path that needs bespoke work, and two rounds of design review with business leaders. Plan at the high figure.

| Phase | Work | Low hours | High hours | Main driver of the range |
|---|---|---|---|---|
| 1 | Discovery: six platform tracks, identity, showback and environment workshops, report, integration matrix, access requests, environment specification | 80 | 120 | APEX unknowns; number of owners to meet |
| 2 | Access and environment: request writing, follow-up with internal teams, server specification, proxy and certificate work, security review inputs, verification of each path | 40 | 80 | CG lead times and rework on requests |
| 3 | Design and development: showback design with leaders, showback views, APEX connector, adaptation of the five vendor connectors, live statistics, cost model and labelling, organisation correlation, security hardening, proxy and certificate support, installation and runbook | 240 | 320 | APEX connector; design review rounds |
| 4 | Data gathering remediation: fix loop per platform with its owner, identity resolution, gap closure, unmatched usage reduction | 70 | 120 | Response shapes that differ from documentation |
| 5 | Metrics and cost reconciliation: per platform closed day and month, billing comparison, Power BI comparison, rate confirmation, restricted-consumer tests, report | 90 | 130 | Billing statement availability; differences to explain |
| 6 | Handover and support: walkthroughs, document set, support window | 40 | 60 | Length of the support window |
| All | Governance: weekly status, point-of-contact time, change control, issue tracking | 30 | 50 | Engagement length |
| | Total | 590 | 880 | |

### 8.2 Schedule

Durations are Trace3 estimates, not commitments, and assume the dependencies in section 6 are met. Phases overlap: access requests go out as each platform's discovery closes, build starts in week 3 on the platforms already understood, and remediation starts per platform the day its credentials arrive.

| Week | Eight-week plan | What pushes it toward twelve weeks |
|---|---|---|
| 1 to 3 | Discovery for all platforms; access requests issued from week 2; server, network and firewall requests issued by end of week 2 | APEX owner or data not identified; platform owners unavailable |
| 2 to 5 | Access and environment: credentials, server, proxy, certificate, firewall rules landed; each path proven by the connection tests | Internal approval cycles longer than three weeks; security review of the application required before access is granted |
| 3 to 6 | Design with business leaders (weeks 3 to 4); build and hardening; production install by end of week 6 | Second design review round; APEX needs a database or export path rather than an API |
| 5 to 7 | Remediation per platform as credentials arrive; all platforms pulling real data by end of week 7 | Credentials arriving after week 5 push that platform's remediation and reconciliation out one for one |
| 6 to 8 | Reconciliation of the most recent closed day and closed month per platform against the platform's reporting and billing; Power BI comparison; access tests; report and sign-off | A full calendar month run in parallel needs every connector live before that month starts, which the eight-week plan cannot promise; the twelve-week plan reconciles one full calendar month |
| 8 | Handover walkthroughs; support window starts | |

The one item the team controls that decides the outcome is issuing complete, correct access and environment requests in weeks 1 and 2. Everything after that is paced by Capital Group's internal lead times, so the weekly status note tracks each request from issue to grant as its own line.

## 9. Acceptance

A deliverable is accepted when its acceptance statement in section 4 is met and the Capital Group product owner confirms it in writing or by email within ten business days of delivery. Silence for ten business days after a written delivery notice is treated as acceptance. A rejection names the specific acceptance statement that is not met.

## 10. Governance and change control

A weekly written status note covers progress against the phases, open dependencies, risks and decisions needed. A single Capital Group point of contact and a single Trace3 point of contact own the engagement. Changes to scope, assumptions or deliverables are raised as written change requests with their effect on schedule and, where applicable, on the order form; no change is worked until both parties agree it. Issues are tracked in a shared list with owner, date raised and status.

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| APEX has no readable interface or no cost data | APEX coverage limited to what it records | Discovery settles the integration path first; a database or export read is acceptable |
| Access requests take longer than planned | Phase 4 slips per platform | Requests written in phase 1 with exact hosts, ports and permissions; phases proceed per platform |
| Vendor API responses differ from documentation | Fix loops take longer | Connection tests report every step with vendor error text; estimates include a loop per platform |
| Microsoft exposes no supported per-user credit history | Cowork credits stay a monthly snapshot | Labelled as such; revisit when Microsoft publishes a report API |
| Bedrock caller identity does not name a person | Bedrock cost lands as unattributed | Discovery confirms how principals call Bedrock; request metadata or per-user roles if needed |
| Billed cost and API usage do not tie out | Leaders question the figures | Reconciliation explains each difference; allocated figures labelled; confidence stated per platform |
| Corporate proxy or TLS inspection blocks egress | Pulls fail inside CG | Proxy and corporate CA support built in; egress host list published per integration |
| Figures read as Finance expense | Misuse of the dashboard | Standing caveat kept on every page and export; rates confirmed with Finance |

## 12. Security and data handling

Sign-in sessions are server-side with HttpOnly cookies; every write requires a request header that blocks cross-site forgery; every API route sits behind the sign-in gate. Vendor keys, the directory bind password and the Power BI secret are encrypted at rest with AES-256-GCM under a key held outside the repository. Data scopes are enforced on every read. Usage data stays on the Capital Group server; no data leaves the environment except the outbound platform API calls needed to pull it. Trace3 does not retain Capital Group data after handover. The security review of 5 November 2026 and its closure evidence are part of deliverable D6.

## 13. Commercial terms

Fees, invoicing schedule, payment terms, expenses and the engagement model (fixed fee or time and materials) are stated in the Trace3 order form that accompanies this statement of work. This document defines scope, deliverables and acceptance only. [ORDER FORM REFERENCE]

## 14. Approval

| | Capital Group | Trace3 |
|---|---|---|
| Name | [NAME] | [NAME] |
| Title | [TITLE] | [TITLE] |
| Signature | | |
| Date | | |
