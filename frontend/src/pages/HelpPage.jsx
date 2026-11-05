import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useQuery } from '../lib/query.js';
import { IntegrationBlocks, CopyTextButton, KindChip } from '../components/help/IntegrationBlocks.jsx';

const FILTERS = [{ value: 'all', label: 'All' }, { value: 'built', label: 'Built' }, { value: 'planned', label: 'Planned' }];

export default function HelpPage() {
  const q = useQuery('/help/integrations', {}, { events: [] });
  const [filter, setFilter] = useState('all');
  const { hash } = useLocation();
  const rows = q.data ? q.data.rows : null;
  const shown = useMemo(() => (rows || []).filter((r) => filter === 'all' || r.status === filter), [rows, filter]);

  useEffect(() => {
    if (!rows || !hash) return;
    const id = hash.slice(1);
    const target = rows.find((r) => r.id === id);
    if (target && filter !== 'all' && target.status !== filter) { setFilter('all'); return; }
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [rows, hash, filter]);

  return (
    <div className="page">
      <PageHeader title="Integration requirements"
        description="What each integration needs before it can connect: addresses, ports, credentials and the permissions behind them. Planned connectors show what the research found."
        right={<SegmentedControl label="Filter integrations" value={filter} options={FILTERS} onChange={setFilter} />} />
      <DataState q={q} skeleton={<SkeletonCard height={320} />}>
        {() => (
          <div className="flex flex-col gap-4">
            {shown.map((e) => (
              <Card key={e.id} id={e.id} title={e.name} caption={e.summary} style={{ scrollMarginTop: 72 }}
                right={<div className="flex items-center gap-2 flex-wrap justify-end">
                  <StatusChip status={e.status === 'built' ? 'pass' : 'skip'}>{e.status === 'built' ? 'Built' : 'Planned'}</StatusChip>
                  <KindChip kind={e.kind} />
                </div>}>
                <IntegrationBlocks e={e} />
                <div style={{ marginTop: 14 }}><CopyTextButton e={e} /></div>
              </Card>
            ))}
            {shown.length === 0 && <p className="t-small text-muted">No integrations match this filter.</p>}
          </div>
        )}
      </DataState>
    </div>
  );
}
