import React, { useEffect, useMemo, useState } from 'react';
import DataState from '../DataState.jsx';
import Button from '../ui/Button.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { SectionCard, useSaver } from './shared.jsx';
import { useQuery } from '../../lib/query.js';
import { api } from '../../lib/api.js';

const BLANK = { job_function: '', u_lob_2: '', lob_cg: '', lob_cg_sort: 999 };

function Form({ data }) {
  const [rows, setRows] = useState(data.rows);
  useEffect(() => { setRows(data.rows); }, [data]);
  const { save, saving } = useSaver();
  const dirty = JSON.stringify(rows) !== JSON.stringify(data.rows);
  // One sort value per label: a label with two sort values would split into two rows.
  const split = useMemo(() => {
    const by = {};
    rows.forEach((r) => { if (r.lob_cg) { (by[r.lob_cg] = by[r.lob_cg] || new Set()).add(String(r.lob_cg_sort)); } });
    return Object.keys(by).filter((k) => by[k].size > 1);
  }, [rows]);
  const empty = rows.some((r) => !r.lob_cg.trim());
  const edit = (i, k, v) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <SectionCard id="lob-cg" title="LOB-CG map" caption="Maps a job function and level-2 organisation to a LOB-CG label and its sort order. Saving rebuilds the organisation figures."
      dirty={dirty} saving={saving} disabled={split.length > 0 || empty}
      onSave={() => save(() => api.put('/settings/lob-cg-map', { rows: rows.map((r) => ({ ...r, lob_cg_sort: Number(r.lob_cg_sort) })) }), 'Saved. Organisation figures are rebuilding.')}
      extra={<Button variant="ghost" size="sm" onClick={() => setRows((c) => c.concat({ ...BLANK }))}>Add row</Button>}>
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        <table className="tbl compact" aria-label="LOB-CG map">
          <thead>
            <tr>{['Job function', 'Level-2 organisation', 'LOB-CG', 'Sort', ''].map((h, i) => <th key={i} className={h === 'Sort' ? 'r' : ''} style={{ position: 'sticky', top: 0, background: 'var(--bg-1)' }}>{h || 'Remove'}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="input" style={{ width: '100%', minWidth: 150 }} aria-label="Job function" value={r.job_function} onChange={(e) => edit(i, 'job_function', e.target.value)} /></td>
                <td><input className="input" style={{ width: '100%', minWidth: 150 }} aria-label="Level-2 organisation" value={r.u_lob_2} onChange={(e) => edit(i, 'u_lob_2', e.target.value)} /></td>
                <td><input className="input" style={{ width: '100%', minWidth: 150 }} aria-label="LOB-CG" value={r.lob_cg} onChange={(e) => edit(i, 'lob_cg', e.target.value)} /></td>
                <td className="r"><input className="input num" type="number" min="0" style={{ width: 70, textAlign: 'right' }} aria-label="Sort" value={r.lob_cg_sort} onChange={(e) => edit(i, 'lob_cg_sort', e.target.value)} /></td>
                <td><Button variant="ghost" size="sm" aria-label={'Remove row ' + (i + 1)} onClick={() => setRows((c) => c.filter((_, j) => j !== i))}>Remove</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {split.length > 0 && <p className="t-small m-0" role="alert" style={{ marginTop: 8, color: 'var(--fail)' }}>Each label needs one sort value. Fix: {split.join(', ')}.</p>}
      {empty && <p className="t-small m-0" role="alert" style={{ marginTop: 8, color: 'var(--fail)' }}>Every row needs a LOB-CG label.</p>}
    </SectionCard>
  );
}

export default function LobMapSection() {
  const q = useQuery('/settings/lob-cg-map', {});
  return <DataState q={q} skeleton={<SkeletonCard height={300} />}>{(d) => <Form data={d} />}</DataState>;
}
