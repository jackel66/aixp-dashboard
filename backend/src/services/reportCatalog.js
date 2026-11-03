'use strict';
// Report catalogue (CONTRACT section 12). The frontend reads this from GET /api/reports and never
// hard-codes it. Column types: text|money|number|units|pct|date|platform|delta.
// pct columns carry a percent number (25 means 25 percent), delta.pct too. Money columns carry USD numbers.
// units columns carry {value, unit}. delta columns carry {now, prev, delta, pct}.
// models_adoption and models_by_group add one column per model in the response (their catalogue
// entry lists only the fixed columns); the response `columns` is always the complete list.
const platformsMod = require('../platforms');

const GROUPS = [
  { id: 'users', title: 'Users' },
  { id: 'platforms', title: 'Platforms' },
  { id: 'models', title: 'Models' },
  { id: 'costs', title: 'Costs' },
];

const col = (key, label, type) => ({ key, label, type });
const PUSD = platformsMod.PLATFORMS.map((p) => col(`usd_${p.id}`, `${p.name} spend`, 'money'));

const REPORTS = [
  {
    id: 'users_top', group: 'users', title: 'Top users by spend',
    description: 'The people with the highest spend in the range, with the split by platform.',
    params: ['range', 'platform', 'limit'],
    columns: [col('rank', 'Rank', 'number'), col('user', 'User', 'text'), col('lob_cg', 'LOB-CG', 'text'), col('region', 'Region', 'text'),
      col('usd', 'Spend', 'money'), ...PUSD, col('active_days', 'Active days', 'number'), col('share', 'Share of spend', 'pct')],
  },
  {
    id: 'users_new', group: 'users', title: 'New users',
    description: 'People whose first activity in the dataset falls inside the range.',
    params: ['range', 'platform', 'limit'],
    columns: [col('user', 'User', 'text'), col('lob_cg', 'LOB-CG', 'text'), col('first_seen', 'First seen', 'date'),
      col('first_platform', 'First platform', 'platform'), col('usd_since', 'Spend since first seen', 'money'), col('platforms', 'Platforms', 'number')],
  },
  {
    id: 'users_inactive', group: 'users', title: 'Inactive users',
    description: 'People active in the 90 days before the range who show no activity inside it.',
    params: ['range', 'platform', 'limit'],
    columns: [col('user', 'User', 'text'), col('lob_cg', 'LOB-CG', 'text'), col('last_seen', 'Last seen', 'date'),
      col('days_silent', 'Days silent', 'number'), col('usd_before', 'Spend in the 90 days before', 'money')],
  },
  {
    id: 'users_multi_platform', group: 'users', title: 'Users on several platforms',
    description: 'People active on two or more platforms in the range.',
    params: ['range', 'platform', 'limit'],
    columns: [col('user', 'User', 'text'), col('lob_cg', 'LOB-CG', 'text'), col('platform_count', 'Platforms used', 'number'),
      ...PUSD, col('usd', 'Spend', 'money')],
  },
  {
    id: 'users_by_group', group: 'users', title: 'Users and spend by group',
    description: 'Active users and spend per organisation group. Choose the grouping with dim.',
    params: ['range', 'platform', 'basis', 'dim', 'limit'],
    columns: [col('group', 'Group', 'text'), col('users', 'Active users', 'number'), col('usd', 'Spend', 'money'),
      col('usd_per_user', 'Spend per user', 'money'), col('share', 'Share of spend', 'pct')],
  },
  {
    id: 'users_unmatched', group: 'users', title: 'Unmatched usage keys',
    description: 'Usage keys that have no row in the People table.',
    params: ['range', 'platform', 'limit'],
    columns: [col('person_key', 'Key', 'text'), col('platforms', 'Platforms', 'number'), col('rows', 'Usage rows', 'number'),
      col('usd', 'Spend', 'money'), col('first_seen', 'First seen', 'date'), col('last_seen', 'Last seen', 'date')],
  },
  {
    id: 'platforms_summary', group: 'platforms', title: 'Platform summary',
    description: 'One row per platform: spend by basis, consumption, users and seat use.',
    params: ['range', 'platform', 'basis'],
    columns: [col('platform', 'Platform', 'platform'), col('as_of', 'Data through', 'date'), col('lag_days', 'Lag (days)', 'number'),
      col('consumption_usd', 'Consumption spend', 'money'), col('seat_usd', 'Seat spend', 'money'), col('total_usd', 'Total spend', 'money'),
      col('consumption', 'Consumption', 'units'), col('active_users', 'Active users', 'number'),
      col('usd_per_active_user', 'Spend per active user', 'money'), col('licensed_seats', 'Licensed seats', 'number'),
      col('seat_utilisation_pct', 'Seat utilisation', 'pct')],
  },
  {
    id: 'platforms_monthly', group: 'platforms', title: 'Platform spend by month',
    description: 'Spend per platform for each month in the range, with the change against the previous month.',
    params: ['range', 'platform', 'basis'],
    columns: [col('month', 'Month', 'text'), ...PUSD, col('total', 'Total', 'money'), col('delta', 'Change vs previous month', 'delta')],
  },
  {
    id: 'platforms_freshness', group: 'platforms', title: 'Platform data freshness',
    description: 'How current each platform feed is and how many verification checks it fails.',
    params: ['platform'],
    columns: [col('platform', 'Platform', 'platform'), col('as_of', 'Data through', 'date'), col('lag_days', 'Lag (days)', 'number'),
      col('stale', 'Stale', 'text'), col('coverage_from', 'Coverage from', 'date'), col('coverage_to', 'Coverage to', 'date'),
      col('rows', 'Usage rows', 'number'), col('checks_failed', 'Checks failed', 'number'), col('checks_warn', 'Checks warning', 'number')],
  },
  {
    id: 'platforms_seat_utilisation', group: 'platforms', title: 'Seat utilisation',
    description: 'Licensed seats against active people for each platform and month.',
    params: ['range', 'platform'],
    columns: [col('platform', 'Platform', 'platform'), col('month', 'Month', 'text'), col('licensed_seats', 'Licensed seats', 'number'),
      col('active_people', 'Active people', 'number'), col('utilisation_pct', 'Utilisation', 'pct'), col('seat_usd', 'Seat spend', 'money'),
      col('consumption_usd', 'Consumption spend', 'money'), col('usd_per_active', 'Spend per active person', 'money')],
  },
  {
    id: 'models_cost', group: 'models', title: 'Model cost',
    description: 'Spend, volume and users for every model on the token platforms.',
    params: ['range', 'platform', 'limit'],
    columns: [col('platform', 'Platform', 'platform'), col('model', 'Model', 'text'), col('usd', 'Spend', 'money'),
      col('consumption', 'Tokens', 'units'), col('requests', 'Requests', 'number'), col('users', 'Users', 'number'),
      col('cost_per_million', 'Cost per million tokens', 'money'), col('share', 'Share of spend', 'pct')],
  },
  {
    id: 'models_adoption', group: 'models', title: 'Model adoption',
    description: 'Average daily active users per week for the eight highest spend models.',
    params: ['range', 'platform'],
    columns: [col('week', 'Week', 'text')],
  },
  {
    id: 'models_by_group', group: 'models', title: 'Model spend by group',
    description: 'Spend per organisation group for the eight highest spend models.',
    params: ['range', 'platform', 'dim', 'limit'],
    columns: [col('group', 'Group', 'text'), col('total', 'Total', 'money')],
  },
  {
    id: 'costs_monthly', group: 'costs', title: 'Monthly costs',
    description: 'Consumption and seat spend for each month in the range, with users and spend per user.',
    params: ['range', 'platform'],
    columns: [col('month', 'Month', 'text'), col('consumption_usd', 'Consumption spend', 'money'), col('seat_usd', 'Seat spend', 'money'),
      col('total_usd', 'Total spend', 'money'), col('delta_total', 'Change vs previous month', 'delta'),
      col('active_users', 'Active users', 'number'), col('usd_per_user', 'Spend per user', 'money')],
  },
  {
    id: 'costs_by_group', group: 'costs', title: 'Costs by group',
    description: 'Consumption spend and allocated seat spend per organisation group.',
    params: ['range', 'platform', 'dim', 'limit'],
    columns: [col('group', 'Group', 'text'), col('consumption_usd', 'Consumption spend', 'money'), col('seat_usd', 'Seat spend (allocated)', 'money'),
      col('total_usd', 'Total spend', 'money'), col('share', 'Share of total', 'pct'), col('users', 'Active users', 'number'),
      col('usd_per_user', 'Spend per user', 'money')],
  },
  {
    id: 'costs_movers', group: 'costs', title: 'Biggest movers',
    description: 'Platforms and groups ranked by the size of their change against the previous window of the same length.',
    params: ['range', 'platform', 'basis', 'dim', 'limit'],
    columns: [col('kind', 'Kind', 'text'), col('name', 'Name', 'text'), col('now', 'This period', 'money'), col('prev', 'Previous period', 'money'),
      col('delta', 'Change', 'delta'), col('pct', 'Change (%)', 'pct')],
  },
  {
    id: 'costs_per_user', group: 'costs', title: 'Cost per user',
    description: 'Spend and consumption per active user for each platform.',
    params: ['range', 'platform', 'basis'],
    columns: [col('platform', 'Platform', 'platform'), col('active_users', 'Active users', 'number'), col('usd', 'Spend', 'money'),
      col('usd_per_user', 'Spend per user', 'money'), col('consumption_per_user', 'Consumption per user', 'units')],
  },
];

const BY_ID = new Map(REPORTS.map((r) => [r.id, r]));

const get = (id) => BY_ID.get(id) || null;
const list = () => ({ groups: GROUPS, reports: REPORTS });

module.exports = { GROUPS, REPORTS, get, list, col };
