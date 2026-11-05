'use strict';
// Permission catalogue and system roles (CONTRACT section 14.1).

const CATALOGUE = [
  { key: 'dashboard.view', label: 'View the dashboard', description: 'Landing, overview, platform pages, organization, models, data quality, reports (except the user reports), trend, summary and the dataset list.' },
  { key: 'people.view', label: 'View people', description: 'The users list and detail, the user drawer, the user reports and the top users tables (person-level usage).' },
  { key: 'export.csv', label: 'Export CSV', description: 'Download CSV exports. A user report export also needs people.view.' },
  { key: 'data.manage', label: 'Manage data', description: 'Verify, promote and roll back datasets, generate fixtures and pull from Power BI.' },
  { key: 'settings.manage', label: 'Change settings', description: 'Read and change settings such as seat rates and the LOB-CG map.' },
  { key: 'access.manage', label: 'Manage access', description: 'Users, roles, role assignments, the Active Directory connection and sign-in activity.' },
  { key: 'data.all', label: 'All lines of business', description: 'See every line of business and the Unmatched and Unassigned buckets. Without it, a user sees only the LOB-CG values granted to them.' },
];

const KEYS = CATALOGUE.map((p) => p.key);

// Short phrase per key for the 403 message: "You do not have permission to <verb>".
const VERBS = {
  'dashboard.view': 'view the dashboard',
  'people.view': 'view people',
  'export.csv': 'export CSV',
  'data.manage': 'manage data',
  'settings.manage': 'change settings',
  'access.manage': 'manage access',
  'data.all': 'see every line of business',
};

const SYSTEM_ROLES = [
  { name: 'Administrator', description: 'Every permission.', permissions: KEYS.slice() },
  { name: 'Executive', description: 'Dashboards and CSV export, no person-level data.', permissions: ['dashboard.view', 'export.csv', 'data.all'] },
  { name: 'Analyst', description: 'Dashboards, person-level usage and CSV export.', permissions: ['dashboard.view', 'people.view', 'export.csv', 'data.all'] },
  { name: 'Viewer', description: 'Dashboards only.', permissions: ['dashboard.view'] },
];

const isKey = (k) => KEYS.includes(k);
const verbFor = (key) => VERBS[key] || key;

module.exports = { CATALOGUE, KEYS, VERBS, SYSTEM_ROLES, isKey, verbFor };
