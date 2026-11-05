import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useQuery } from '../lib/query.js';
import { IntegrationBlocks, CopyTextButton, KindChip } from '../components/help/IntegrationBlocks.jsx';

const FILTERS = [{ value: 'all', label: 'All' }, { value: 'built', label: 'Built' }, { value: 'planned', label: 'Planned' }];

function Dot({ status }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, flex: '0 0 auto', background: status === 'built' ? 'var(--ok)' : 'transparent', border: '2px solid ' + (status === 'built' ? 'var(--ok)' : 'var(--faint)'), boxSizing: 'border-box' }} />;
}

function Body({ rows }) {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const [filter, setFilter] = useState('all');
  const shown = useMemo(() => rows.filter((r) => filter === 'all' || r.status === filter), [rows, filter]);
  const tab = params.get('tab') || (hash ? hash.slice(1) : '');
  const current = rows.find((r) => r.id === tab) || shown[0] || rows.find((r) => r.status === 'built') || rows[0];

  // A #id hash from an older link selects the tab once, then the URL carries ?tab=.
  useEffect(() => {
    if (!params.get('tab') && hash && rows.some((r) => r.id === hash.slice(1))) setParams({ tab: hash.slice(1) }, { replace: true });
  }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id) => setParams({ tab: id });
  const pick = (v) => { setFilter(v); const first = rows.find((r) => v === 'all' || r.status === v); if (first && current && v !== 'all' && current.status !== v) go(first.id); };
  if (!current) return <p className="t-small text-muted">No integrations are listed.</p>;
  const idx = shown.findIndex((r) => r.id === current.id);
  const prev = idx > 0 ? shown[idx - 1] : null;
  const next = idx >= 0 && idx < shown.length - 1 ? shown[idx + 1] : null;

  return (
    <div className="help-layout">
      <div className="help-side">
        <div style={{ marginBottom: 12 }}><SegmentedControl label="Filter integrations" value={filter} options={FILTERS} onChange={pick} /></div>
        <nav aria-label="Integrations" className="help-rail flex flex-col gap-1">
          {shown.map((r) => (
            <Link key={r.id} title={r.status === 'built' ? 'Built' : 'Planned'} to={'/help?tab=' + r.id} className="nav-link" aria-current={r.id === current.id ? 'page' : undefined} style={{ justifyContent: 'flex-start', alignItems: 'flex-start', gap: 10, height: 'auto', minHeight: 36, paddingTop: 8, paddingBottom: 8, lineHeight: 1.3 }}>
              <span style={{ marginTop: 5, display: 'flex' }}><Dot status={r.status} /></span><span style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
            </Link>
          ))}
          {shown.length === 0 && <p className="t-small text-muted">No integrations match this filter.</p>}
        </nav>
        <select className="input help-select" aria-label="Integration" value={current.id} onChange={(e) => go(e.target.value)} style={{ width: '100%' }}>
          {shown.some((r) => r.id === current.id) ? null : <option value={current.id}>{current.name}</option>}
          {shown.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.status === 'built' ? 'built' : 'planned'})</option>)}
        </select>
      </div>
      <div className="help-main">
        <Card id={current.id} title={current.name} caption={current.summary}
          right={<div className="flex items-center gap-2 flex-wrap justify-end">
            <StatusChip status={current.status === 'built' ? 'pass' : 'skip'}>{current.status === 'built' ? 'Built' : 'Planned'}</StatusChip>
            <KindChip kind={current.kind} />
          </div>}>
          <IntegrationBlocks e={current} />
          <div style={{ marginTop: 14 }}><CopyTextButton e={current} /></div>
        </Card>
        <div className="flex justify-between gap-4 flex-wrap" style={{ marginTop: 16 }}>
          {prev ? <Link to={'/help?tab=' + prev.id}>Previous: {prev.name}</Link> : <span />}
          {next ? <Link to={'/help?tab=' + next.id}>Next: {next.name}</Link> : <span />}
        </div>
      </div>
    </div>
  );
}

export default function HelpPage() {
  const q = useQuery('/help/integrations', {}, { events: [] });
  return (
    <div className="page">
      <PageHeader title="Integration requirements"
        description="What each integration needs before it can connect: addresses, ports, credentials and the permissions behind them. Planned connectors show what the research found." />
      <DataState q={q} skeleton={<SkeletonCard height={320} />}>{(data) => <Body rows={data.rows || []} />}</DataState>
    </div>
  );
}
