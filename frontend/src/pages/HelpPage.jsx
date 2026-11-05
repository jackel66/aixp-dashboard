import React, { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useQuery } from '../lib/query.js';
import { IntegrationBlocks, CopyTextButton, KindChip } from '../components/help/IntegrationBlocks.jsx';

function Body({ rows }) {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const tab = params.get('tab') || (hash ? hash.slice(1) : '');
  const current = rows.find((r) => r.id === tab) || rows[0];

  // A #id hash from an older link selects the tab once, then the URL carries ?tab=.
  useEffect(() => {
    if (!params.get('tab') && hash && rows.some((r) => r.id === hash.slice(1))) setParams({ tab: hash.slice(1) }, { replace: true });
  }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id) => setParams({ tab: id });
  if (!current) return <p className="t-small text-muted">No integrations are listed.</p>;
  const idx = rows.findIndex((r) => r.id === current.id);
  const prev = idx > 0 ? rows[idx - 1] : null;
  const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;

  return (
    <div className="help-layout">
      <div className="help-side">
        <nav aria-label="Integrations" className="help-rail flex flex-col gap-1">
          {rows.map((r) => (
            <Link key={r.id} to={'/help?tab=' + r.id} className="nav-link" aria-current={r.id === current.id ? 'page' : undefined} style={{ justifyContent: 'flex-start', alignItems: 'flex-start', height: 'auto', minHeight: 36, paddingTop: 8, paddingBottom: 8, lineHeight: 1.3 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
            </Link>
          ))}
        </nav>
        <select className="input help-select" aria-label="Integration" value={current.id} onChange={(e) => go(e.target.value)} style={{ width: '100%' }}>
          {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div className="help-main">
        <Card id={current.id} title={current.name} caption={current.summary} right={<KindChip kind={current.kind} />}>
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
        description="What each integration needs before it can connect: addresses, ports, credentials and the permissions behind them." />
      <DataState q={q} skeleton={<SkeletonCard height={320} />}>{(data) => <Body rows={data.rows || []} />}</DataState>
    </div>
  );
}
