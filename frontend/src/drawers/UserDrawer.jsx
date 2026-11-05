import React, { useMemo } from 'react';
import Drawer from '../components/ui/Drawer.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import Button from '../components/ui/Button.jsx';
import Chip from '../components/ui/Chip.jsx';
import UnitBadge from '../components/ui/UnitBadge.jsx';
import { SkeletonRows } from '../components/ui/Skeleton.jsx';
import ShareDonut from '../components/charts/ShareDonut.jsx';
import TrendChart from '../components/charts/TrendChart.jsx';
import { useQuery } from '../lib/query.js';
import { isMock } from '../lib/api.js';
import { platformName } from '../lib/platforms.js';
import { money, moneyFull, units, count, dateShort, dateLong } from '../lib/format.js';

const SPEND_SERIES_ID = 'daily';

function H({ children }) {
  return <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>{children}</h3>;
}

function Body({ d }) {
  const p = d.person;
  const donut = useMemo(() => d.platforms.filter((x) => x.usd > 0).map((x) => ({ id: x.id, label: platformName(x.id), value: x.usd })), [d]);
  const labels = useMemo(() => d.trend.map((t) => dateShort(t.date)), [d]);
  const series = useMemo(() => [{ id: SPEND_SERIES_ID, label: 'Daily spend', data: d.trend.map((t) => t.usd) }], [d]);
  const attrs = [
    ['LOB-CG', p.lob_cg], ['Region', p.region], ['SBL', p.sbl], ['Office', p.office_code],
    ['Person type', p.person_type], ['Email', p.email], ['User ID', p.user_id]
  ].filter((a) => a[1]);
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="t-stat num">{moneyFull(d.spend.usd)}</span>
        <span className="text-muted">across all platforms, last 90 days</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 8 }}>
        <Chip tone="accent">{p.person_type}</Chip>
        <Chip>{p.lob_cg}</Chip>
        {p.origin === 'vendor' && <Chip tone="outline" title="This person is not in the extract. The LOB-CG comes from the vendor org mapping.">LOB from vendor org</Chip>}
        <Chip tone="outline">{p.region}</Chip>
        <Chip tone="outline">{p.sbl}</Chip>
        {p.office_code && <Chip tone="outline">Office {p.office_code}</Chip>}
        {p.matched === 0 && <Chip tone="warn">Not in people list</Chip>}
      </div>

      <H>Spend by platform</H>
      <ShareDonut items={donut} height={150} ariaLabel={'Share of spend in US dollars by platform for ' + (p.display_name || p.person_key)} />

      <H>Daily spend, last 90 days</H>
      <TrendChart type="line" labels={labels} series={series} height={170} ariaLabel="Daily spend in US dollars over the last 90 days" />

      <H>Platform activity</H>
      <table className="tbl compact">
        <thead><tr><th>Platform</th><th className="r">Spend (USD)</th><th className="r">Consumption</th><th className="r">Active days</th></tr></thead>
        <tbody>
          {d.platforms.map((x) => (
            <tr key={x.id}>
              <td>{platformName(x.id)}</td>
              <td className="r num">{money(x.usd)}</td>
              <td className="r num">{units(x.consumption.value, x.consumption.unit)}</td>
              <td className="r num">{count(x.active_days)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <H>Organisation</H>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 m-0">
        {attrs.map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}><dt className="t-small text-muted">{k}</dt><dd className="m-0" style={{ overflowWrap: 'anywhere' }}>{v}</dd></div>
        ))}
      </dl>

      <H>Recent activity</H>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <table className="tbl compact">
          <thead><tr><th style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>Date</th><th style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>Platform</th><th style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>Model</th><th className="r" style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>Consumption</th><th className="r" style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>Spend (USD)</th></tr></thead>
          <tbody>
            {d.activity.map((a, i) => (
              <tr key={i}>
                <td className="num">{dateLong(a.date)}</td>
                <td>{platformName(a.platform)}</td>
                <td>{a.model || '-'}</td>
                <td className="r num"><span className="inline-flex items-center gap-1 justify-end">{units(a.consumption.value, '')}<UnitBadge unit={a.consumption.unit} /></span></td>
                <td className="r num">{money(a.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Button as="a" variant="secondary" size="sm" href={'/api/export/users.csv?person_key=' + encodeURIComponent(p.person_key)} download>Download this user as CSV</Button>
      </div>
    </div>
  );
}

export default function UserDrawer({ open, id, onClose }) {
  const path = id ? (isMock ? '/user-detail' : '/users/' + encodeURIComponent(id)) : null;
  const q = useQuery(path, {}, { enabled: open && !!id });
  const d = q.data;
  const title = d ? (d.person.display_name || d.person.person_key) + ' (' + d.person.person_key + ')' : (id || 'User');
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      {q.error && d === undefined && (
        <EmptyState tone="error" title="Could not load this user" body={q.error.message} action={<Button variant="secondary" onClick={q.reload}>Retry</Button>} />
      )}
      {d === undefined && !q.error && <SkeletonRows rows={8} rowHeight={32} />}
      {d && <Body d={d} />}
    </Drawer>
  );
}
