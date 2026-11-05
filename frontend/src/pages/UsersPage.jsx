import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import DataTable from '../components/ui/DataTable.jsx';
import Button from '../components/ui/Button.jsx';
import Chip from '../components/ui/Chip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useDrawers } from '../drawers/DrawerHost.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useQuery, buildUrl } from '../lib/query.js';
import { PLATFORMS, platformName } from '../lib/platforms.js';
import { money, count, dateLong } from '../lib/format.js';

// Server-paged user list. State lives in the URL: q, sort, dir, page, platform and the org filters
// (lob_cg, region, sbl, person_type) that the Organization matrix links to.
const ORG_KEYS = ['lob_cg', 'region', 'sbl', 'person_type'];
const ORG_LABEL = { lob_cg: 'LOB-CG', region: 'Region', sbl: 'SBL', person_type: 'Person type' };
const SORT_DEFAULT = 'usd';

function PlatformDots({ platforms }) {
  const on = PLATFORMS.filter((p) => platforms && platforms[p.id] > 0);
  if (!on.length) return <span className="text-muted">-</span>;
  return (
    <span className="inline-flex items-center gap-1" title={on.map((p) => p.name + ' ' + money(platforms[p.id])).join(', ')}>
      {on.map((p) => <span key={p.id} aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--p-' + p.id + ')', display: 'inline-block' }} />)}
      <span className="sr-only">{on.map((p) => p.name).join(', ')}</span>
    </span>
  );
}

export default function UsersPage() {
  const [sp, setSp] = useSearchParams();
  const { openUser } = useDrawers();
  const { scope } = useAuth();
  const scopeLobs = !scope.all ? scope.lob_cg : [];
  const urlQ = sp.get('q') || '';
  const sort = sp.get('sort') || SORT_DEFAULT;
  const dir = sp.get('dir') || (sort === 'name' || sort === 'lob_cg' ? 'asc' : 'desc');
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const platform = sp.get('platform') || '';
  const orgFilters = ORG_KEYS.filter((k) => sp.get(k)).map((k) => [k, sp.get(k)]);

  // Debounced search: the box owns its text, the URL follows 250 ms later.
  const [text, setText] = useState(urlQ);
  const spRef = useRef(sp);
  spRef.current = sp;
  useEffect(() => { setText(urlQ); }, [urlQ]);
  useEffect(() => {
    if (text === urlQ) return undefined;
    const t = setTimeout(() => update({ q: text, page: '' }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const update = useCallback((patch) => {
    const next = new URLSearchParams(spRef.current);
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      next.delete(k);
      if (v !== '' && v !== null && v !== undefined) next.set(k, v);
    });
    setSp(next, { replace: true });
  }, [setSp]);

  const params = { q: urlQ, sort, dir, page, pageSize: 50, platform };
  orgFilters.forEach(([k, v]) => { params[k] = v; });
  const q = useQuery('/users', params);
  const d = q.data;
  const pageSize = d ? d.pageSize : 50;
  const pages = d ? Math.max(1, Math.ceil(d.total / pageSize)) : 1;

  const onSort = (key) => {
    if (key === sort) update({ dir: dir === 'desc' ? 'asc' : 'desc', page: '' });
    else update({ sort: key, dir: key === 'name' || key === 'lob_cg' ? 'asc' : 'desc', page: '' });
  };

  const columns = [
    { key: 'name', label: 'User', sortable: true, render: (r) => <span>{r.display_name || r.person_key}</span> },
    { key: 'lob_cg', label: 'LOB-CG', sortable: true, render: (r) => (r.matched === 0 ? <Chip tone="outline">Unmatched</Chip> : <span>{r.lob_cg}{r.origin === 'vendor' && <Chip tone="outline" className="ml-2" title="This person is not in the extract. The LOB-CG comes from the vendor org mapping.">LOB from vendor org</Chip>}</span>) },
    { key: 'region', label: 'Region', render: (r) => r.region },
    { key: 'sbl', label: 'SBL', render: (r) => r.sbl },
    { key: 'person_type', label: 'Type', render: (r) => r.person_type },
    { key: 'platforms', label: 'Platforms', render: (r) => <PlatformDots platforms={r.platforms} /> },
    { key: 'usd', label: 'Spend (USD)', align: 'r', sortable: true, render: (r) => money(r.usd) },
    { key: 'active_days', label: 'Active days', align: 'r', sortable: true, render: (r) => count(r.active_days) }
  ];

  const first = d ? (d.total === 0 ? 0 : (page - 1) * pageSize + 1) : 0;
  const last = d ? Math.min(d.total, page * pageSize) : 0;
  const csv = '/api' + buildUrl('/export/users.csv', { q: urlQ, platform, ...Object.fromEntries(orgFilters) });

  return (
    <div className="page">
      <PageHeader eyebrow="Users" title="Users"
        description="Everyone with AI usage in the period, ranked by spend. Open a person to see their platforms, models and daily activity."
        right={d ? <Chip tone="outline">Data to {dateLong(d.asOf)}</Chip> : null} />
      <Card title="People" caption="Spend in US dollars across all platforms. Search matches alias, name and email."
        right={<a href={csv} className="t-small" download>Export CSV</a>}>
        <DataState q={q} skeleton={<SkeletonCard height={420} />}>
          {(data) => (
            <DataTable ariaLabel="Users" columns={columns} rows={data.rows} rowKey="person_key"
              sort={{ key: sort, dir }} onSort={onSort} onRowClick={(r) => openUser(r.person_key)}
              maxHeight="calc(100vh - 340px)"
              emptyTitle="No users match" emptyBody="Try a different search or clear the filters."
              toolbar={(
                <>
                  <label className="inline-flex items-center gap-2">
                    <span className="sr-only">Search users</span>
                    <input className="input" type="search" placeholder="Search alias, name or email" value={text} style={{ width: 260 }}
                      onChange={(e) => setText(e.target.value)} />
                  </label>
                  <label className="inline-flex items-center gap-2 t-small text-muted">
                    Platform
                    <select className="input" value={platform} onChange={(e) => update({ platform: e.target.value, page: '' })}>
                      <option value="">All platforms</option>
                      {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  {scopeLobs.length > 1 && (
                    <label className="inline-flex items-center gap-2 t-small text-muted">
                      LOB-CG
                      <select className="input" value={sp.get('lob_cg') || ''} onChange={(e) => update({ lob_cg: e.target.value, page: '' })}>
                        <option value="">All of my lines</option>
                        {scopeLobs.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  )}
                  {orgFilters.map(([k, v]) => (
                    <button key={k} type="button" className="chip chip-accent cursor-pointer" onClick={() => update({ [k]: '', page: '' })} aria-label={'Remove filter ' + ORG_LABEL[k] + ' ' + v}>
                      {ORG_LABEL[k]}: {v} (remove)
                    </button>
                  ))}
                </>
              )} />
          )}
        </DataState>
        {d && (
          <div className="flex items-center justify-between gap-3 flex-wrap" style={{ marginTop: 12 }}>
            <span className="text-muted t-small" aria-live="polite">Showing {count(first)} to {count(last)} of {count(d.total)}{platform ? ' on ' + platformName(platform) : ''}</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => update({ page: page - 1 > 1 ? page - 1 : '' })}>Previous</Button>
              <span className="t-small num">Page {page} of {pages}</span>
              <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => update({ page: page + 1 })}>Next</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
