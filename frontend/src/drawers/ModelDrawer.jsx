import React, { useMemo } from 'react';
import Drawer from '../components/ui/Drawer.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import Button from '../components/ui/Button.jsx';
import UnitBadge from '../components/ui/UnitBadge.jsx';
import { SkeletonRows } from '../components/ui/Skeleton.jsx';
import TrendChart from '../components/charts/TrendChart.jsx';
import { useDrawers } from './DrawerHost.jsx';
import { useQuery } from '../lib/query.js';
import { isMock } from '../lib/api.js';
import { platformName } from '../lib/platforms.js';
import { money, moneyFull, units, count, dateShort } from '../lib/format.js';

function Stat({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="t-micro text-muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600 }}>{label}</dt>
      <dd className="m-0 t-h2 num" style={{ marginTop: 2 }}>{children}</dd>
    </div>
  );
}

function Body({ d, platform }) {
  const { openUser } = useDrawers();
  const labels = useMemo(() => d.trend.map((t) => dateShort(t.start)), [d]);
  const series = useMemo(() => [{ id: 'weekly', label: 'Weekly spend', platform, data: d.trend.map((t) => t.usd) }], [d, platform]);
  return (
    <div>
      <p className="text-muted m-0">{platformName(d.platform)}, spend in US dollars, consumption in {d.consumption.unit}.</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 m-0" style={{ marginTop: 12 }}>
        <Stat label="Spend">{moneyFull(d.usd)}</Stat>
        <Stat label="Consumption">
          <span className="inline-flex items-center gap-2">{units(d.consumption.value, d.consumption.unit)}</span>
        </Stat>
        <Stat label="Requests">{count(d.requests)}</Stat>
        <Stat label="Active users">{count(d.users)}</Stat>
      </dl>

      <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>Weekly spend, last 12 weeks</h3>
      <TrendChart type="line" labels={labels} series={series} height={170} ariaLabel={'Weekly spend in US dollars for ' + d.model + ', last 12 weeks'} />

      {!d.top_users_hidden && (
        <>
      <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>Top 10 users</h3>
      <table className="tbl compact">
        <thead><tr><th>User</th><th>LOB-CG</th><th className="r">Spend (USD)</th><th className="r">Consumption</th></tr></thead>
        <tbody>
          {d.top_users.map((u) => (
            <tr key={u.person_key} className="row-btn" onClick={() => openUser(u.person_key)} style={{ cursor: 'pointer' }}>
              <td><button type="button" className="row-button" style={{ whiteSpace: "nowrap" }} onClick={(e) => { e.stopPropagation(); openUser(u.person_key); }}>{u.display_name || u.person_key}</button></td>
              <td>{u.lob_cg}</td>
              <td className="r num">{money(u.usd)}</td>
              <td className="r num" style={{ whiteSpace: "nowrap" }}>{units(u.consumption.value, u.consumption.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
        </>
      )}
    </div>
  );
}

export default function ModelDrawer({ open, platform, model, onClose }) {
  const path = platform && model ? (isMock ? '/model-detail' : '/models/' + encodeURIComponent(platform) + '/' + encodeURIComponent(model)) : null;
  const q = useQuery(path, {}, { enabled: open && !!path });
  const d = q.data;
  return (
    <Drawer open={open} title={model || 'Model'} onClose={onClose}>
      {d && <div style={{ marginBottom: 8 }}><UnitBadge unit={d.consumption.unit} /></div>}
      {q.error && d === undefined && (
        <EmptyState tone="error" title="Could not load this model" body={q.error.message} action={<Button variant="secondary" onClick={q.reload}>Retry</Button>} />
      )}
      {d === undefined && !q.error && <SkeletonRows rows={8} rowHeight={32} />}
      {d && <Body d={d} platform={platform} />}
    </Drawer>
  );
}
