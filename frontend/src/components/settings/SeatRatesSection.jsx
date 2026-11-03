import React, { useEffect, useState } from 'react';
import DataState from '../DataState.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { SectionCard, useSaver } from './shared.jsx';
import { useQuery } from '../../lib/query.js';
import { api } from '../../lib/api.js';
import { platformName } from '../../lib/platforms.js';

function Form({ data }) {
  const [rows, setRows] = useState(data.rows);
  useEffect(() => { setRows(data.rows); }, [data]);
  const { save, saving } = useSaver();
  const dirty = JSON.stringify(rows) !== JSON.stringify(data.rows);
  const bad = rows.some((r) => !(Number(r.rate_usd) >= 0) || !(Number(r.licensed_seats) >= 0));
  const edit = (i, k, v) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <SectionCard id="seat-rates" title="Seat rates" caption="Monthly seat rate in US dollars per seat and the number of licensed seats, by platform and month. Seat spend is rate times seats."
      dirty={dirty} saving={saving} disabled={bad}
      onSave={() => save(() => api.put('/settings/seat-rates', { rows: rows.map((r) => ({ ...r, rate_usd: Number(r.rate_usd), licensed_seats: Number(r.licensed_seats) })) }))}>
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        <table className="tbl compact" aria-label="Seat rates">
          <thead>
            <tr>
              {['Platform', 'Month', 'Rate (USD per seat)', 'Licensed seats'].map((h, i) => (
                <th key={h} className={i > 1 ? 'r' : ''} style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.platform + r.month}>
                <td>{platformName(r.platform)}</td>
                <td className="num">{r.month}</td>
                <td className="r"><input className="input num" type="number" min="0" step="0.01" style={{ width: 110, textAlign: 'right' }} aria-label={'Rate for ' + platformName(r.platform) + ' ' + r.month} value={r.rate_usd} onChange={(e) => edit(i, 'rate_usd', e.target.value)} /></td>
                <td className="r"><input className="input num" type="number" min="0" step="1" style={{ width: 100, textAlign: 'right' }} aria-label={'Seats for ' + platformName(r.platform) + ' ' + r.month} value={r.licensed_seats} onChange={(e) => edit(i, 'licensed_seats', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bad && <p className="t-small m-0" role="alert" style={{ marginTop: 8, color: 'var(--fail)' }}>Rates and seats must be zero or more.</p>}
    </SectionCard>
  );
}

export default function SeatRatesSection() {
  const q = useQuery('/settings/seat-rates', {});
  return <DataState q={q} skeleton={<SkeletonCard height={300} />}>{(d) => <Form data={d} />}</DataState>;
}
