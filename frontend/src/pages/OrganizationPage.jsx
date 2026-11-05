import React from 'react';
import PageHeader from '../components/PageHeader.jsx';
import FilterBar from '../components/FilterBar.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import Chip from '../components/ui/Chip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import Matrix from '../components/org/Matrix.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useQuery, buildUrl } from '../lib/query.js';
import { useUrlFilters } from '../lib/filters.js';
import { BASIS_LABEL } from '../lib/platforms.js';
import { dateLong } from '../lib/format.js';

const DEFAULTS = { rows: 'lob_cg', measure: 'spend', basis: 'consumption' };
const ROWS = [
  { value: 'lob_cg', label: 'LOB-CG' },
  { value: 'region', label: 'Region' },
  { value: 'sbl', label: 'SBL' },
  { value: 'person_type', label: 'Person type' }
];
const MEASURES = [
  { value: 'spend', label: 'Spend' },
  { value: 'users', label: 'Active users' },
  { value: 'units', label: 'Units' }
];
const CAPTION = {
  spend: (b) => 'US dollars, ' + b + ' basis. Hover or focus a cell for its top contributors.',
  users: () => 'Distinct active people. A person active on two platforms counts once per platform.',
  units: () => 'Tokens for Anthropic and OpenAI, credits for GitHub Copilot and Copilot Cowork. The two units are never added together.'
};

export default function OrganizationPage() {
  const { values, set } = useUrlFilters(DEFAULTS);
  const { scope } = useAuth();
  const dim = ROWS.some((r) => r.value === values.rows) ? values.rows : DEFAULTS.rows;
  const measure = MEASURES.some((m) => m.value === values.measure) ? values.measure : DEFAULTS.measure;
  const basis = values.basis;
  const params = { dim, measure, basis };
  const q = useQuery('/organization', params);
  const d = q.data;
  const csv = '/api' + buildUrl('/export/organization.csv', params);

  return (
    <div className="page">
      <PageHeader eyebrow="Organization" title="Who uses AI"
        description={scope.all ? 'Spend, active people and consumption by organisational group and platform.' : 'Your lines of business: spend, active people and consumption by group and platform.'}
        right={d ? <Chip tone="outline">Data to {dateLong(d.asOf)}</Chip> : null} />
      <FilterBar values={values} set={set} showRange={false} showBasis={measure === 'spend'}>
        <SegmentedControl label="Rows" value={dim} options={ROWS} onChange={(v) => set({ rows: v })} />
        <SegmentedControl label="Measure" value={measure} options={MEASURES} onChange={(v) => set({ measure: v })} />
      </FilterBar>
      <DataState q={q} skeleton={<SkeletonCard height={360} />}>
        {(data) => (
          <Card title={ROWS.find((r) => r.value === dim).label + ' by platform'}
            caption={CAPTION[measure]((BASIS_LABEL[basis] || basis).toLowerCase())}
            right={<a href={csv} className="t-small" download>Export CSV</a>}>
            <Matrix data={data} measure={measure} dim={dim} />
          </Card>
        )}
      </DataState>
    </div>
  );
}
