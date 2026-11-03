import React, { useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import DataTable from '../components/ui/DataTable.jsx';
import Chip from '../components/ui/Chip.jsx';
import UnitBadge from '../components/ui/UnitBadge.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useDrawers } from '../drawers/DrawerHost.jsx';
import { useQuery } from '../lib/query.js';
import { useUrlFilters } from '../lib/filters.js';
import { PLATFORMS, platformName } from '../lib/platforms.js';
import { money, count, units, pct, perMillion, dateLong } from '../lib/format.js';

const TOKEN_PLATFORMS = PLATFORMS.filter((p) => p.models);

function PlatformMark({ id }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--p-' + id + ')', display: 'inline-block' }} />
      {platformName(id)}
    </span>
  );
}

export default function ModelsPage() {
  const { values, set } = useUrlFilters({});
  const q = useQuery('/models', {});
  const { openModel } = useDrawers();
  const [sort, setSort] = useState({ key: 'usd', dir: 'desc' });
  const chosen = values.platform;

  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'model' || key === 'platform' ? 'asc' : 'desc' }));
  const toggle = (id) => set({ platform: chosen.includes(id) ? chosen.filter((x) => x !== id) : chosen.concat(id) });

  const rows = useMemo(() => {
    const all = q.data ? q.data.rows : [];
    const f = chosen.length ? all.filter((r) => chosen.includes(r.platform)) : all;
    const val = (r) => (sort.key === 'consumption' ? r.consumption.value : r[sort.key]);
    return f.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(y) : (x || 0) - (y || 0);
      return sort.dir === 'asc' ? c : -c;
    });
  }, [q.data, chosen, sort]);

  const columns = [
    { key: 'model', label: 'Model', sortable: true, render: (r) => r.model },
    { key: 'platform', label: 'Platform', sortable: true, render: (r) => <PlatformMark id={r.platform} /> },
    { key: 'usd', label: 'Spend (USD)', align: 'r', sortable: true, render: (r) => money(r.usd) },
    { key: 'consumption', label: 'Consumption', align: 'r', sortable: true, render: (r) => units(r.consumption.value, r.consumption.unit) },
    { key: 'requests', label: 'Requests', align: 'r', sortable: true, render: (r) => count(r.requests) },
    { key: 'users', label: 'Active users', align: 'r', sortable: true, render: (r) => count(r.users) },
    { key: 'share', label: 'Share of spend', align: 'r', sortable: true, render: (r) => pct(r.share * 100, 0) },
    { key: 'cost_per_unit', label: 'Cost per million tokens', align: 'r', sortable: true, title: 'Spend divided by tokens, token platforms only', render: (r) => (r.cost_per_unit === null || r.cost_per_unit === undefined ? '-' : perMillion(r.cost_per_unit)) }
  ];

  return (
    <div className="page">
      <PageHeader eyebrow="Models" title="Models"
        description="Spend and consumption by model. Only Anthropic and OpenAI report a model name, so GitHub Copilot and Copilot Cowork do not appear here."
        right={q.data ? <Chip tone="outline">Data to {dateLong(q.data.asOf)}</Chip> : null} />
      <DataState q={q} skeleton={<SkeletonCard height={320} />}>
        {() => (
          <Card title="All models" caption="Spend in US dollars. Consumption is in tokens for every model on this page." right={<UnitBadge unit="tokens" />}>
            <DataTable ariaLabel="Models" columns={columns} rows={rows} rowKey={(r) => r.platform + ':' + r.model}
              sort={sort} onSort={onSort} onRowClick={(r) => openModel(r.platform, r.model)}
              emptyTitle="No models match" emptyBody="Clear the platform filter to see every model."
              toolbar={(
                <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Platform filter">
                  {TOKEN_PLATFORMS.map((p) => {
                    const on = chosen.includes(p.id);
                    return (
                      <button key={p.id} type="button" aria-pressed={on} onClick={() => toggle(p.id)}
                        className={'chip cursor-pointer ' + (on ? 'chip-accent' : 'chip-outline')} style={{ height: 28 }}>
                        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--p-' + p.id + ')', display: 'inline-block' }} />
                        {p.name}{on ? ' (on)' : ''}
                      </button>
                    );
                  })}
                  {chosen.length > 0 && <button type="button" className="t-small text-muted underline bg-transparent border-0 cursor-pointer" onClick={() => set({ platform: [] })}>Clear</button>}
                </div>
              )} />
          </Card>
        )}
      </DataState>
    </div>
  );
}
