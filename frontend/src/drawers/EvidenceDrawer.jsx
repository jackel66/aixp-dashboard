import React from 'react';
import Drawer from '../components/ui/Drawer.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import Button from '../components/ui/Button.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import Chip from '../components/ui/Chip.jsx';
import { SkeletonRows } from '../components/ui/Skeleton.jsx';
import { useQuery } from '../lib/query.js';
import { isMock } from '../lib/api.js';
import { platformName } from '../lib/platforms.js';
import { count, dateShort } from '../lib/format.js';

export function chipStatus(c) {
  if (c.status === 'pass') return 'pass';
  if (c.status === 'skip') return 'skip';
  return c.severity === 'fail' ? 'fail' : c.severity === 'warn' ? 'warn' : 'info';
}

const GLYPH = { pass: 'M3 8.5l3.2 3L13 4.5', fail: 'M4 4l8 8 M12 4l-8 8', skip: 'M4 8h8' };
const WORD = { pass: 'Passed', fail: 'Failed', skip: 'Skipped' };
const COLOR = { pass: 'var(--ok)', fail: 'var(--fail)', skip: 'var(--faint)' };

function RunDot({ h }) {
  const s = GLYPH[h.status] ? h.status : 'skip';
  return (
    <li className="flex flex-col items-center gap-1" style={{ minWidth: 40 }} title={WORD[s] + ' on ' + String(h.ran_at).slice(0, 10)}>
      <span style={{ width: 22, height: 22, borderRadius: 11, border: '2px solid ' + COLOR[s], display: 'grid', placeItems: 'center' }}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={COLOR[s]} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GLYPH[s]} /></svg>
      </span>
      <span className="t-micro text-muted">{dateShort(h.ran_at)}</span>
      <span className="sr-only">{WORD[s]} on {String(h.ran_at).slice(0, 10)}</span>
    </li>
  );
}

function cellText(row, col, i) {
  const v = Array.isArray(row) ? row[i] : row[col];
  return v === null || v === undefined ? '' : String(v);
}

function Body({ d }) {
  const ev = d.evidence || { columns: [], rows: [], total: 0 };
  const shown = ev.rows.slice(0, 20);
  const metrics = Object.entries(d.metrics || {});
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <StatusChip status={chipStatus(d)} />
        {d.platform && <Chip tone="outline">{platformName(d.platform)}</Chip>}
        <Chip tone="outline">Severity: {d.severity}</Chip>
      </div>
      <p style={{ marginTop: 12 }}>{d.message}</p>

      <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>Expected and found</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 m-0">
        <div><dt className="t-small text-muted">Expected</dt><dd className="m-0 num">0 affected rows</dd></div>
        <div><dt className="t-small text-muted">Found</dt><dd className="m-0 num">{count(d.affected)} affected</dd></div>
        {metrics.map(([k, v]) => (
          <div key={k}><dt className="t-small text-muted">{k.replace(/_/g, ' ')}</dt><dd className="m-0 num">{typeof v === 'number' ? count(v) : String(v)}</dd></div>
        ))}
      </dl>

      <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>Sample rows</h3>
      {shown.length ? (
        <>
          <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
            <table className="tbl compact">
              <thead><tr>{ev.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {shown.map((r, ri) => (
                  <tr key={ri}>{ev.columns.map((c, ci) => <td key={c} className="num" style={{ whiteSpace: 'nowrap' }}>{cellText(r, c, ci)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-small text-muted m-0" style={{ marginTop: 6 }}>Showing {shown.length} of {count(ev.total)} rows.</p>
        </>
      ) : <p className="text-muted m-0">No sample rows for this result.</p>}

      <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>What this means</h3>
      <p className="m-0">{d.meaning}</p>

      <h3 className="t-h3" style={{ margin: '20px 0 8px' }}>Last 10 runs</h3>
      {d.history && d.history.length ? (
        <ul className="list-none p-0 m-0 flex gap-1 flex-wrap">{d.history.map((h) => <RunDot key={h.run_id} h={h} />)}</ul>
      ) : <p className="text-muted m-0">No earlier runs.</p>}
    </div>
  );
}

export default function EvidenceDrawer({ open, id, platform, onClose }) {
  const vq = useQuery('/verification', {}, { enabled: open && !!id });
  const runId = vq.data && vq.data.run ? vq.data.run.id : null;
  const path = id && runId ? (isMock ? '/verification-run' : '/verification/runs/' + runId + '/checks/' + encodeURIComponent(id)) : null;
  const q = useQuery(path, { platform: platform || '' }, { enabled: open && !!path });
  const d = q.data;
  const err = q.error || vq.error;
  return (
    <Drawer open={open} title={d ? d.title : 'Check evidence'} onClose={onClose}>
      {err && d === undefined && (
        <EmptyState tone="error" title="Could not load this check" body={err.message} action={<Button variant="secondary" onClick={() => { vq.reload(); q.reload(); }}>Retry</Button>} />
      )}
      {d === undefined && !err && <SkeletonRows rows={8} rowHeight={32} />}
      {d && <Body d={d} />}
    </Drawer>
  );
}
