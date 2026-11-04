'use strict';
// Settings defaults (CONTRACT section 4). Values are stored as JSON strings by db.open().

// Seed LOB-CG mapping (CONTRACT section 2). One sort value per label.
// Sorts: EDO 1, NACG 2, GRM 3, L&C 4, Workplace Experience 5, then the rest.
const LOBCG_SEED = [
  { job_function: 'Data Engineering', u_lob_2: 'Enterprise Data Office', lob_cg: 'EDO', lob_cg_sort: 1 },
  { job_function: 'Data Science', u_lob_2: 'Enterprise Data Office', lob_cg: 'EDO', lob_cg_sort: 1 },
  { job_function: 'Data Governance', u_lob_2: 'Enterprise Data Office', lob_cg: 'EDO', lob_cg_sort: 1 },
  { job_function: 'Data Analytics', u_lob_2: 'Enterprise Data Office', lob_cg: 'EDO', lob_cg_sort: 1 },
  { job_function: 'Data Analytics', u_lob_2: 'GBS Data Analytics Rotations and Trainin', lob_cg: 'NACG', lob_cg_sort: 2 },
  { job_function: 'Risk Analysis', u_lob_2: 'Global Risk Management', lob_cg: 'GBS - GRM', lob_cg_sort: 3 },
  { job_function: 'Risk Operations', u_lob_2: 'Global Risk Management', lob_cg: 'GBS - GRM', lob_cg_sort: 3 },
  { job_function: 'Legal', u_lob_2: 'Legal and Compliance', lob_cg: 'GBS - L&C', lob_cg_sort: 4 },
  { job_function: 'Compliance', u_lob_2: 'Legal and Compliance', lob_cg: 'GBS - L&C', lob_cg_sort: 4 },
  { job_function: 'Facilities', u_lob_2: 'Workplace Experience', lob_cg: 'GBS - Workplace Experience', lob_cg_sort: 5 },
  { job_function: 'Workplace Services', u_lob_2: 'Workplace Experience', lob_cg: 'GBS - Workplace Experience', lob_cg_sort: 5 },
  { job_function: 'Software Engineering', u_lob_2: 'Technology Services', lob_cg: 'Technology', lob_cg_sort: 6 },
  { job_function: 'Infrastructure', u_lob_2: 'Technology Services', lob_cg: 'Technology', lob_cg_sort: 6 },
  { job_function: 'Client Operations', u_lob_2: 'Operations', lob_cg: 'Operations', lob_cg_sort: 7 },
  { job_function: 'Process Excellence', u_lob_2: 'Operations', lob_cg: 'Operations', lob_cg_sort: 7 },
  { job_function: 'Accounting', u_lob_2: 'Finance', lob_cg: 'Finance', lob_cg_sort: 8 },
  { job_function: 'Financial Planning', u_lob_2: 'Finance', lob_cg: 'Finance', lob_cg_sort: 8 },
  { job_function: 'Portfolio Analytics', u_lob_2: 'Investments', lob_cg: 'Investments', lob_cg_sort: 10 },
  { job_function: 'Research', u_lob_2: 'Investments', lob_cg: 'Investments', lob_cg_sort: 10 },
];

const DEFAULTS = {
  'spend.seat_basis': 'licensed',
  'spend.default_basis': 'consumption',
  'cowork.rate': 0.008,
  'cowork.rate_confirmed': false,
  'verify.stale_days': 5,
  'verify.gap_days': 2,
  'verify.unmatched_pct': 2,
  'verify.delta_pct': 25,
  'fixture.options': { seed: 20261103, months: 12, people: 400, profile: 'defective' },
  'datasets.keep': 5,
  'lobcg.seed': LOBCG_SEED,
  // Power BI connector (CONTRACT section 13). The two secrets are stored encrypted; '' = not set.
  'powerbi.enabled': false,
  'powerbi.auth_mode': 'service_principal',
  'powerbi.tenant_id': '',
  'powerbi.client_id': '',
  'powerbi.client_secret': '',
  'powerbi.token': '',
  'powerbi.workspace_id': '',
  'powerbi.dataset_id': '',
  'powerbi.dataset_name': '',
  'powerbi.tables': { usage: 'Usage', people: 'People', seat_rate: 'SeatRate', region_map: 'RegionMap', lob_cg_map: 'LobCgMap' },
  'powerbi.date_column': 'Date',
  'powerbi.months_back': 13,
  'powerbi.auto_promote': true,
  'powerbi.schedule': '',
  'powerbi.last_pull_at': null,
  'powerbi.last_pull': null,
  // Active Directory (CONTRACT section 14.5). ad.bind_password is stored encrypted.
  'ad.enabled': false,
  'ad.domain': '',
  'ad.bind_user': '',
  'ad.bind_password': '',
  'ad.servers': '',
  'ad.base_dn': '',
  'ad.tls_mode': 'auto',
  'ad.tls_verify': true,
  'ad.ca_cert': '',
  'ad.sync_minutes': 60,
  'ad.deactivate_removed': true,
  'ad.discovered': null,
  'ad.status': null,
};

module.exports = { DEFAULTS, LOBCG_SEED };
