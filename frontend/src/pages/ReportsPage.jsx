import React from 'react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import DataState from '../components/DataState.jsx';
import HoverCard from '../components/ui/HoverCard.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useQuery } from '../lib/query.js';

function ReportCard({ r, onOpen }) {
  const n = r.columns.length;
  return (
    <HoverCard placement="bottom" width={300} className="block"
      trigger={(
        <button type="button" className="card card-hover text-left cursor-pointer w-full" style={{ display: 'block', font: 'inherit', color: 'inherit' }}
          onClick={() => onOpen(r.id)} aria-label={r.title + ', ' + (n === 1 ? '1 column' : n + ' columns')}>
          <h3 className="t-h2 m-0">{r.title}</h3>
          <p className="t-small text-muted" style={{ marginTop: 4, minHeight: 32 }}>{r.description}</p>
          <p className="t-small text-faint m-0" style={{ marginTop: 8 }}>{n === 1 ? '1 column' : n + ' columns'}</p>
        </button>
      )}>
      <div className="t-h3" style={{ marginBottom: 6 }}>Columns</div>
      <ul className="list-none m-0 p-0 t-small">
        {r.columns.map((c) => <li key={c.key}>{c.label}</li>)}
      </ul>
    </HoverCard>
  );
}

export default function ReportsPage() {
  const q = useQuery('/reports', {});
  const nav = useNavigate();
  return (
    <div className="page">
      <PageHeader eyebrow="Reports" title="Reports"
        description="Ready-made tables for the questions that come up most. Each report follows the date range and spend basis you choose, and exports to CSV." />
      <DataState q={q} skeleton={<SkeletonCard height={320} />}>
        {(cat) => (
          <div className="stack-32">
            {cat.groups.map((g) => {
              const list = cat.reports.filter((r) => r.group === g.id);
              if (!list.length) return null;
              return (
                <section key={g.id} aria-labelledby={'grp-' + g.id}>
                  <h2 id={'grp-' + g.id} className="t-h3" style={{ marginBottom: 12 }}>{g.title}</h2>
                  <div className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                    {list.map((r) => <ReportCard key={r.id} r={r} onOpen={(id) => nav('/reports/' + id)} />)}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </DataState>
    </div>
  );
}
