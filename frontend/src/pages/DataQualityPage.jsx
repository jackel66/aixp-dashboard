import React, { useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import DataState from '../components/DataState.jsx';
import ConfidenceChip from '../components/ConfidenceChip.jsx';
import DataTable from '../components/ui/DataTable.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import Button from '../components/ui/Button.jsx';
import Dialog from '../components/ui/Dialog.jsx';
import Chip from '../components/ui/Chip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { datasetSource } from '../components/AsOfChip.jsx';
import { useDrawers } from '../drawers/DrawerHost.jsx';
import { chipStatus } from '../drawers/EvidenceDrawer.jsx';
import { useQuery, clearQueryCache } from '../lib/query.js';
import { api } from '../lib/api.js';
import { PLATFORMS } from '../lib/platforms.js';
import { count, dateLong, money } from '../lib/format.js';

function CheckRow({ c, ranAt, onEvidence }) {
  const [open, setOpen] = useState(false);
  const metrics = Object.entries(c.metrics || {});
  const id = 'chk-' + c.id + '-' + (c.platform || 'all');
  return (
    <li style={{ borderBottom: '1px solid var(--line)' }}>
      <div className="flex items-center gap-3 flex-wrap" style={{ padding: '8px 0' }}>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 bg-transparent border-0 cursor-pointer text-ink text-left" style={{ flex: 1, minWidth: 260, font: 'inherit' }}>
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor" style={{ transform: open ? 'rotate(90deg)' : 'none', flex: '0 0 auto' }}><path d="M3 1.5l6 4.5-6 4.5z" /></svg>
          <StatusChip status={chipStatus(c)} />
          <span style={{ fontWeight: 500 }}>{c.title}</span>
        </button>
        <span className="t-small text-muted num" title="Last run">Last run {ranAt ? dateLong(ranAt) : 'not yet'}</span>
        <span className="t-small num" style={{ minWidth: 90, textAlign: 'right' }}>{c.affected ? count(c.affected) + ' affected' : 'None affected'}</span>
        <Button variant="secondary" size="sm" onClick={() => onEvidence(c)}>Evidence</Button>
      </div>
      {open && (
        <div id={id} style={{ padding: '0 0 12px 22px' }}>
          <p className="m-0">{c.message}</p>
          {metrics.length > 0 && (
            <dl className="grid gap-x-4 gap-y-1 m-0" style={{ marginTop: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
              {metrics.map(([k, v]) => <div key={k}><dt className="t-small text-muted">{k.replace(/_/g, ' ')}</dt><dd className="m-0 num">{typeof v === 'number' ? count(v) : String(v)}</dd></div>)}
            </dl>
          )}
          <p className="m-0 text-muted" style={{ marginTop: 8 }}><span style={{ fontWeight: 600 }}>What this means.</span> {c.meaning}</p>
        </div>
      )}
    </li>
  );
}

function Checks({ v }) {
  const { openCheck } = useDrawers();
  const groups = useMemo(() => {
    const out = PLATFORMS.map((p) => ({ id: p.id, name: p.name, items: v.checks.filter((c) => c.platform === p.id) }));
    out.push({ id: 'all', name: 'All platforms', items: v.checks.filter((c) => !c.platform) });
    return out.filter((g) => g.items.length);
  }, [v]);
  return (
    <div className="stack-32">
      {groups.map((g) => {
        const bad = g.items.filter((c) => c.status === 'fail' && c.severity !== 'info').length;
        return (
          <Card key={g.id} title={g.name} caption={bad ? bad + ' of ' + g.items.length + ' checks need review.' : 'All ' + g.items.length + ' checks clear.'}>
            <ul className="list-none p-0 m-0" style={{ borderTop: '1px solid var(--line)' }}>
              {g.items.map((c) => <CheckRow key={c.id + (c.platform || '')} c={c} ranAt={v.run.ran_at} onEvidence={(x) => openCheck(x.id, x.platform)} />)}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

function Datasets({ q }) {
  const toast = useToast();
  const [act, setAct] = useState(null); // { kind: 'verify' | 'rollback', row }
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (act.kind === 'verify') await api.post('/datasets/' + act.row.id + '/verify', {});
      else await api.post('/datasets/rollback', { to: act.row.id });
      toast.success(act.kind === 'verify' ? 'Verification finished for dataset ' + act.row.id : 'Rolled back to dataset ' + act.row.id);
      setAct(null);
      clearQueryCache();
    } catch (e) {
      toast.error(e.message || 'The action failed');
    } finally { setBusy(false); }
  };
  const d = q.data;
  const columns = [
    { key: 'label', label: 'Dataset', render: (r) => (<span className="inline-flex items-center gap-2">{r.label}{r.id === d.active_id && <Chip tone="accent">current</Chip>}</span>) },
    { key: 'source', label: 'Source', render: (r) => { const s = datasetSource(r); return s.kind === 'powerbi' ? 'Power BI pull' : s.kind === 'fixture' ? 'Fixture' : (s.label || r.source); } },
    { key: 'status', label: 'Status', render: (r) => r.status },
    { key: 'verdict', label: 'Verdict', render: (r) => (r.verdict ? <StatusChip status={r.verdict} /> : <span className="text-muted">Not verified</span>) },
    { key: 'created_at', label: 'Created', render: (r) => dateLong(r.created_at) },
    { key: 'rows', label: 'Rows', align: 'r', render: (r) => count(r.platforms.reduce((a, p) => a + p.rows, 0)) },
    { key: 'cost', label: 'Spend (USD)', align: 'r', render: (r) => money(r.platforms.reduce((a, p) => a + p.cost_usd, 0)) },
    { key: 'actions', label: 'Actions', render: (r) => (
      <span className="inline-flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => setAct({ kind: 'verify', row: r })}>Verify</Button>
        {r.id !== d.active_id && r.status === 'archived' && <Button variant="secondary" size="sm" onClick={() => setAct({ kind: 'rollback', row: r })}>Roll back</Button>}
      </span>
    ) }
  ];
  return (
    <Card title="Datasets" caption="Every dataset loaded, newest first. Rolling back makes an archived dataset current again without re-verifying it.">
      <DataTable ariaLabel="Datasets" columns={columns} rows={d.rows} rowKey="id" showDensity={false} emptyTitle="No datasets yet" />
      <Dialog open={!!act} onClose={() => !busy && setAct(null)} title={act && act.kind === 'verify' ? 'Verify dataset?' : 'Roll back dataset?'}
        footer={(<><Button variant="secondary" onClick={() => setAct(null)} disabled={busy}>Cancel</Button><Button onClick={run} disabled={busy}>{act && act.kind === 'verify' ? 'Run verification' : 'Roll back'}</Button></>)}>
        {act && act.kind === 'verify'
          ? <p className="m-0">Run every check against {act.row.label}. The result replaces the last verdict for this dataset.</p>
          : <p className="m-0">Make {act && act.row.label} the current dataset. Every page switches to its figures right away, and the dataset now in use is archived.</p>}
      </Dialog>
    </Card>
  );
}

export default function DataQualityPage() {
  const vq = useQuery('/verification', {});
  const dq = useQuery('/datasets', {});
  const v = vq.data;
  const conf = v ? { verdict: v.run.verdict, fail: v.run.fail, warn: v.run.warn, info: v.run.info, pass: v.run.pass, ran_at: v.run.ran_at,
    first_failing: (v.checks.find((c) => c.status === 'fail' && c.severity === 'fail') || v.checks.find((c) => c.status === 'fail' && c.severity === 'warn') || null) } : null;
  return (
    <div className="page">
      <PageHeader eyebrow="Data quality" title="Data quality"
        description="Automated checks run on every dataset before it goes live. Open a check for the rows behind it and what it means for the numbers."
        right={conf ? <ConfidenceChip confidence={conf} /> : null} />
      <div className="stack-32">
        <DataState q={vq} skeleton={<SkeletonCard height={300} />}>
          {(data) => (
            <>
              <Card title="Verification summary" caption={'Latest run ' + dateLong(data.run.ran_at) + '.'}>
                <div className="flex items-center gap-6 flex-wrap">
                  <StatusChip status={data.run.verdict} />
                  <span className="num"><span style={{ fontWeight: 600 }}>{data.run.fail}</span> failed</span>
                  <span className="num"><span style={{ fontWeight: 600 }}>{data.run.warn}</span> warnings</span>
                  <span className="num"><span style={{ fontWeight: 600 }}>{data.run.pass}</span> passed</span>
                  <span className="num"><span style={{ fontWeight: 600 }}>{data.run.info}</span> info</span>
                </div>
              </Card>
              <Checks v={data} />
            </>
          )}
        </DataState>
        <DataState q={dq} skeleton={<SkeletonCard height={200} />}>
          {() => <Datasets q={dq} />}
        </DataState>
      </div>
    </div>
  );
}
