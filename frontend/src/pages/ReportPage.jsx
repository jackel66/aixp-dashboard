import React, { useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import FilterBar from '../components/FilterBar.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import DataTable from '../components/ui/DataTable.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import Button from '../components/ui/Button.jsx';
import Chip from '../components/ui/Chip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import ReportChart from '../components/reports/ReportChart.jsx';
import { renderCell, isNumericType } from '../components/reports/reportCells.jsx';
import { useDrawers } from '../drawers/DrawerHost.jsx';
import { useQuery, buildUrl } from '../lib/query.js';
import { useUrlFilters, apiParams } from '../lib/filters.js';
import { PLATFORMS } from '../lib/platforms.js';
import { dateLong } from '../lib/format.js';

const DEFAULTS = { basis: 'consumption', dim: 'lob_cg', limit: '50' };
const DIMS = [{ value: 'lob_cg', label: 'LOB-CG' }, { value: 'region', label: 'Region' }, { value: 'sbl', label: 'SBL' }, { value: 'person_type', label: 'Person type' }];
const LIMITS = ['10', '25', '50', '100', '500'];

export default function ReportPage() {
  const { id } = useParams();
  const { values, set } = useUrlFilters(DEFAULTS);
  const { openUser } = useDrawers();
  const cat = useQuery('/reports', {});
  const meta = cat.data ? cat.data.reports.find((r) => r.id === id) : null;
  const allowed = meta ? meta.params : ['range', 'platform', 'basis', 'dim', 'limit'];
  const has = (k) => allowed.includes(k);

  const params = {};
  if (has('range')) Object.assign(params, apiParams(values, ['from', 'to']));
  if (has('platform')) Object.assign(params, apiParams(values, ['platform']));
  if (has('basis')) params.basis = values.basis;
  if (has('dim')) params.dim = values.dim;
  if (has('limit')) params.limit = values.limit;
  const q = useQuery('/reports/' + id, params);

  // Keep the last good payload for this report so the controls do not vanish while a filter reloads.
  const last = useRef(null);
  if (q.data) last.current = q.data;
  const kept = last.current && last.current.id === id ? last.current : null;
  const shown = q.data || kept;
  const asOf = shown ? shown.asOf : '';
  const range = shown ? { from: values.from || shown.range.from, to: values.to || shown.range.to } : null;
  const title = (shown && shown.title) || (meta && meta.title) || 'Report';
  const description = (shown && shown.description) || (meta && meta.description) || '';
  const exportHref = buildUrl('/api/export/report/' + id + '.csv', params);
  const chosen = values.platform;
  const togglePlatform = (pid) => set({ platform: chosen.includes(pid) ? chosen.filter((x) => x !== pid) : chosen.concat(pid) });
  const dq = q.data === undefined && kept && !q.error ? { ...q, data: kept } : q;

  return (
    <div className="page">
      <PageHeader eyebrow="Reports" title={title} description={description}
        right={(
          <>
            {shown && <Chip tone="outline">As of {dateLong(shown.asOf)}</Chip>}
            <Button as={Link} to="/reports" variant="secondary" size="sm">All reports</Button>
            <Button as="a" href={exportHref} download variant="secondary" size="sm">Export CSV</Button>
          </>
        )} />
      <FilterBar values={values} set={set} asOf={asOf} range={range} showRange={has('range') && !!shown} showBasis={has('basis')}>
        {has('dim') && <SegmentedControl label="Group by" value={values.dim} options={DIMS} onChange={(v) => set({ dim: v })} />}
        {has('platform') && (
          <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Platform filter">
            {PLATFORMS.map((p) => {
              const on = chosen.includes(p.id);
              return (
                <button key={p.id} type="button" aria-pressed={on} onClick={() => togglePlatform(p.id)}
                  className={'chip cursor-pointer ' + (on ? 'chip-accent' : 'chip-outline')} style={{ height: 28 }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--p-' + p.id + ')', display: 'inline-block' }} />
                  {p.name}{on ? ' (on)' : ''}
                </button>
              );
            })}
            {chosen.length > 0 && <button type="button" className="t-small text-muted underline bg-transparent border-0 cursor-pointer" onClick={() => set({ platform: [] })}>Clear</button>}
          </div>
        )}
        {has('limit') && (
          <label className="t-small text-muted">Rows <select className="input" value={values.limit} onChange={(e) => set({ limit: e.target.value })}>
            {LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select></label>
        )}
      </FilterBar>
      <DataState q={dq} skeleton={<div className="stack-32"><SkeletonCard height={300} /><SkeletonCard height={300} /></div>}>
        {(d) => <ReportBody d={d} openUser={openUser} />}
      </DataState>
    </div>
  );
}

function ReportBody({ d, openUser }) {
  const columns = useMemo(() => d.columns.map((c) => ({
    key: c.key, label: c.label, align: isNumericType(c.type) ? 'r' : undefined,
    render: (r) => renderCell(c, r, openUser)
  })), [d.columns, openUser]);
  const rows = useMemo(() => (d.totals ? d.rows.concat({ ...d.totals, __totals: true }) : d.rows), [d]);
  return (
    <div className="stack-32">
      {d.chart && (
        <Card title="Chart" caption="Same range, basis and filters as the table below.">
          <ReportChart reportId={d.id} chart={d.chart} title={d.title} />
        </Card>
      )}
      <Card title="Table" caption={d.rows.length + (d.rows.length === 1 ? ' row' : ' rows') + ', ' + dateLong(d.range.from) + ' to ' + dateLong(d.range.to) + '.'}>
        <DataTable ariaLabel={d.title} columns={columns} rows={rows}
          rowProps={(r) => (r.__totals ? { style: { fontWeight: 600, borderTop: '2px solid var(--line)' } } : {})}
          emptyTitle="No rows in this range" emptyBody="Widen the date range or clear the platform filter." />
        {d.notes && d.notes.length > 0 && (
          <ul className="t-small text-muted" style={{ marginTop: 12, paddingLeft: 18 }}>
            {d.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
