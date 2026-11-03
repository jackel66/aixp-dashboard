import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import DataState from '../DataState.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import Dialog from '../ui/Dialog.jsx';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { useToast } from '../ui/Toast.jsx';
import Card from '../charts/Card.jsx';
import { SectionCard, Field, useSaver } from './shared.jsx';
import { useQuery } from '../../lib/query.js';
import { useLiveRefresh } from '../../lib/live.jsx';
import { api, isMock } from '../../lib/api.js';
import { count, dateLong } from '../../lib/format.js';

const MODES = [
  { value: 'fixture', label: 'Fixture' },
  { value: 'powerbi', label: 'Power BI' }
];
const AUTH = [
  { value: 'service_principal', label: 'Service principal' },
  { value: 'token', label: 'Bearer token' }
];
const TABLE_KEYS = [
  { key: 'usage', label: 'Usage' },
  { key: 'people', label: 'People' },
  { key: 'seat_rate', label: 'Seat rates' },
  { key: 'region_map', label: 'Region map' },
  { key: 'lob_cg_map', label: 'LOB-CG map' }
];
const STAGES = ['auth', 'usage', 'people', 'lookups', 'normalize', 'verify', 'promote', 'done'];
const FULL = { width: '100%' };

const isSet = (v) => !!(v && typeof v === 'object' && v.set);
const timeOk = (v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function when(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function seconds(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  const s = Math.round(ms / 1000);
  return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s';
}

function SecretField({ id, label, stored, value, onChange, hint }) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-2">
        <input id={id} className="input" type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={stored ? 'Stored. Leave blank to keep it.' : 'Not set'} style={{ flex: 1, minWidth: 0 }} />
        {stored && <Chip tone="ok">set</Chip>}
      </div>
    </Field>
  );
}

function Checklist({ r }) {
  const row = (key, ok, label, detail) => (
    <li key={key} className="flex items-center gap-3 flex-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
      <StatusChip status={ok ? 'pass' : 'fail'}>{ok ? 'OK' : 'Failed'}</StatusChip>
      <span style={{ fontWeight: 600, minWidth: 110 }}>{label}</span>
      <span className="t-small text-muted" style={{ flex: 1 }}>{detail}</span>
    </li>
  );
  return (
    <ul className="list-none p-0 m-0" style={{ borderTop: '1px solid var(--line)' }}>
      {row('auth', r.auth && r.auth.ok, 'Sign-in', r.auth && r.auth.ok ? 'Token issued' + (r.auth.expires_in ? ', valid ' + Math.round(r.auth.expires_in / 60) + ' min' : '') : (r.auth && r.auth.error) || 'No token')}
      {row('ws', r.workspace && r.workspace.ok, 'Workspace', r.workspace && r.workspace.ok ? r.workspace.name : (r.workspace && r.workspace.error) || 'Not reached')}
      {row('ds', r.dataset && r.dataset.ok, 'Dataset', r.dataset && r.dataset.ok ? r.dataset.name : (r.dataset && r.dataset.error) || 'Not reached')}
      {(r.tables || []).map((t) => row('t-' + t.key, t.ok, 'Table ' + t.key, t.ok ? (t.name + ': ' + count(t.rows) + ' rows') : (t.name ? t.name + ': ' : '') + t.error))}
      {r.latest && r.latest.usage_max_date && (
        <li className="flex items-center gap-3" style={{ padding: '6px 0' }}>
          <StatusChip status="info">Latest</StatusChip>
          <span className="t-small">Newest usage date is {dateLong(r.latest.usage_max_date)}.</span>
        </li>
      )}
    </ul>
  );
}

function ProgressPanel({ p, onDismiss }) {
  const idx = p.stage === 'error' ? STAGES.indexOf(p.lastStage || 'auth') : STAGES.indexOf(p.stage);
  return (
    <Card title="Pull progress" caption={p.stage === 'done' ? 'Finished.' : p.stage === 'error' ? 'Stopped with an error.' : 'Pulling from Power BI. This page can stay open or be left.'}>
      <ul className="flex flex-wrap gap-2 list-none p-0 m-0" aria-label="Pull stages">
        {STAGES.map((s, i) => {
          let tone = 'outline';
          if (p.stage === 'error' && i === idx) tone = 'fail';
          else if (i < idx || p.stage === 'done') tone = 'ok';
          else if (i === idx) tone = 'accent';
          return <li key={s}><Chip tone={tone} aria-current={i === idx ? 'step' : undefined}>{s}</Chip></li>;
        })}
      </ul>
      <div className="flex gap-6 flex-wrap" style={{ marginTop: 12 }} aria-live="polite">
        <span className="t-small text-muted">Table <span className="num text-ink">{p.table || 'n/a'}</span></span>
        <span className="t-small text-muted">Chunk <span className="num text-ink">{p.chunk !== undefined && p.chunk !== null ? String(p.chunk) : 'n/a'}</span></span>
        <span className="t-small text-muted">Rows so far <span className="num text-ink">{count(p.rows || 0)}</span></span>
      </div>
      {p.message && p.stage !== 'error' && <p className="t-small text-muted m-0" style={{ marginTop: 8 }}>{p.message}</p>}
      {p.stage === 'error' && <p role="alert" className="m-0" style={{ marginTop: 8, color: 'var(--fail)' }}>{p.message || 'The pull failed.'}</p>}
      {p.stage === 'done' && <p className="m-0" style={{ marginTop: 8 }}>Pull complete. <Link to="/data-quality">Open Data quality</Link> to review the checks.</p>}
      {(p.stage === 'done' || p.stage === 'error') && <div style={{ marginTop: 12 }}><Button variant="secondary" size="sm" onClick={onDismiss}>Dismiss</Button></div>}
    </Card>
  );
}

function Form({ s, status, reloadStatus }) {
  const toast = useToast();
  const { save, saving } = useSaver();
  const base = {
    enabled: !!s['powerbi.enabled'],
    auth_mode: s['powerbi.auth_mode'] || 'service_principal',
    tenant_id: s['powerbi.tenant_id'] || '',
    client_id: s['powerbi.client_id'] || '',
    workspace_id: s['powerbi.workspace_id'] || '',
    dataset_id: s['powerbi.dataset_id'] || '',
    tables: Object.assign({ usage: '', people: '', seat_rate: '', region_map: '', lob_cg_map: '' }, s['powerbi.tables'] || {}),
    months_back: String(s['powerbi.months_back'] === undefined ? 13 : s['powerbi.months_back']),
    auto_promote: s['powerbi.auto_promote'] !== false,
    schedule: s['powerbi.schedule'] || ''
  };
  const [f, setF] = useState(base);
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [datasets, setDatasets] = useState(null); // null = not discovered yet
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [ask, setAsk] = useState(false);
  const [progress, setProgress] = useState(null);
  const [pulling, setPulling] = useState(false);
  const lastStage = useRef('auth');
  const timers = useRef([]);
  const sig = JSON.stringify(base);
  useEffect(() => { setF(base); setSecret(''); setToken(''); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const setTable = (k, v) => setF((o) => ({ ...o, tables: { ...o.tables, [k]: v } }));

  const patch = {};
  if (f.enabled !== base.enabled) patch['powerbi.enabled'] = f.enabled;
  if (f.auth_mode !== base.auth_mode) patch['powerbi.auth_mode'] = f.auth_mode;
  ['tenant_id', 'client_id', 'workspace_id'].forEach((k) => { if (f[k].trim() !== base[k]) patch['powerbi.' + k] = f[k].trim(); });
  if (f.dataset_id !== base.dataset_id) {
    patch['powerbi.dataset_id'] = f.dataset_id;
    const hit = (datasets || []).find((d) => d.id === f.dataset_id);
    patch['powerbi.dataset_name'] = hit ? hit.name : '';
  }
  if (JSON.stringify(f.tables) !== JSON.stringify(base.tables)) patch['powerbi.tables'] = f.tables;
  if (f.months_back !== base.months_back) patch['powerbi.months_back'] = Number(f.months_back);
  if (f.auto_promote !== base.auto_promote) patch['powerbi.auto_promote'] = f.auto_promote;
  if (f.schedule !== base.schedule) patch['powerbi.schedule'] = f.schedule;
  if (secret !== '') patch['powerbi.client_secret'] = secret;
  if (token !== '') patch['powerbi.token'] = token;
  const dirty = Object.keys(patch).length > 0;
  const mb = Number(f.months_back);
  const valid = Number.isInteger(mb) && mb >= 1 && mb <= 60 && timeOk(f.schedule);
  const on = f.enabled;

  const discover = async () => {
    setDiscovering(true);
    try {
      const list = await api.get('/powerbi/datasets');
      setDatasets(Array.isArray(list) ? list : []);
      toast.success((Array.isArray(list) ? list.length : 0) + ' datasets found');
    } catch (e) { toast.error(e.message || 'Could not list datasets'); } finally { setDiscovering(false); }
  };
  const runTest = async () => {
    setTesting(true);
    try {
      let r = await api.post('/powerbi/test', {});
      if (isMock) r = (await import('../../mock/powerbi-test.json')).default; // mock mode answers every POST with a bare ok
      setTest(r);
      if (r.ok) toast.success('Connection works'); else toast.error('The connection test found problems');
    } catch (e) { toast.error(e.message || 'Test failed'); setTest(null); } finally { setTesting(false); }
  };

  const onEvent = (ev) => {
    if (!ev || ev.type !== 'import.progress') return;
    if (ev.stage && ev.stage !== 'error') lastStage.current = ev.stage;
    setProgress((p) => ({ ...(p || {}), ...ev, lastStage: lastStage.current }));
    if (ev.stage === 'done') { setPulling(false); toast.success('Power BI pull finished'); reloadStatus(); }
    if (ev.stage === 'error') setPulling(false);
  };
  useLiveRefresh(['import.*'], onEvent);

  const startPull = async () => {
    setAsk(false);
    setPulling(true);
    lastStage.current = 'auth';
    setProgress({ stage: 'auth', rows: 0, table: '', chunk: null, message: 'Starting', lastStage: 'auth' });
    if (isMock) { // no backend and no event stream in mock mode: replay the stages locally
      let rows = 0;
      STAGES.forEach((st, i) => {
        timers.current.push(setTimeout(() => {
          rows += st === 'usage' ? 400000 : st === 'people' ? 400 : 0;
          onEvent({ type: 'import.progress', stage: st, table: st === 'usage' ? 'usage' : st === 'people' ? 'people' : '', chunk: st === 'usage' ? '2026-10' : null, rows, message: st === 'done' ? 'Mock pull complete' : '' });
        }, 500 * (i + 1)));
      });
      return;
    }
    try {
      const r = await api.post('/powerbi/pull', {});
      onEvent({ type: 'import.progress', stage: 'done', rows: r.rows, message: 'Verdict ' + r.verdict + (r.promoted ? ', promoted' : ', not promoted') });
    } catch (e) {
      setPulling(false);
      if (e.status === 409) { toast.error('A pull is already running'); setProgress(null); return; }
      onEvent({ type: 'import.progress', stage: 'error', message: e.message || 'The pull failed' });
    }
  };

  const picked = (datasets || []).some((d) => d.id === f.dataset_id);
  const canAct = !dirty;
  const resultByKey = {};
  if (test) (test.tables || []).forEach((t) => { resultByKey[t.key] = t; });

  return (
    <div className="stack-32">
      <SectionCard id="source" title="Data source" caption="Choose where the dashboard reads its usage rows from. Fixture uses generated sample data. Power BI pulls the real semantic model."
        dirty={dirty} saving={saving} disabled={!valid}
        onSave={() => save(() => api.put('/settings', { patch }), 'Data source settings saved')}>
        <Field label="Mode" hint={on ? 'Pulls land as new datasets and are checked before they go live.' : 'The Power BI settings stay saved but are not used in fixture mode.'}>
          <SegmentedControl label="Data source mode" value={on ? 'powerbi' : 'fixture'} options={MODES} onChange={(v) => set('enabled', v === 'powerbi')} />
        </Field>
        {on && (
          <>
            <Field label="Sign-in method">
              <SegmentedControl label="Sign-in method" value={f.auth_mode} options={AUTH} onChange={(v) => set('auth_mode', v)} />
            </Field>
            {f.auth_mode === 'service_principal' ? (
              <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                <Field label="Tenant ID" htmlFor="pb-tenant"><input id="pb-tenant" className="input num" value={f.tenant_id} onChange={(e) => set('tenant_id', e.target.value)} style={FULL} spellCheck={false} /></Field>
                <Field label="Client ID" htmlFor="pb-client"><input id="pb-client" className="input num" value={f.client_id} onChange={(e) => set('client_id', e.target.value)} style={FULL} spellCheck={false} /></Field>
                <SecretField id="pb-secret" label="Client secret" stored={isSet(s['powerbi.client_secret'])} value={secret} onChange={setSecret} />
              </div>
            ) : (
              <SecretField id="pb-token" label="Bearer token" stored={isSet(s['powerbi.token'])} value={token} onChange={setToken} hint="A pasted user token for a first test. It expires within about an hour." />
            )}
            <Field label="Workspace ID" htmlFor="pb-ws"><input id="pb-ws" className="input num" value={f.workspace_id} onChange={(e) => set('workspace_id', e.target.value)} style={{ width: '100%', maxWidth: 420 }} spellCheck={false} /></Field>
            <Field label="Dataset" htmlFor="pb-ds" hint={f.dataset_id ? 'Current: ' + (s['powerbi.dataset_name'] ? s['powerbi.dataset_name'] + ' ' : '') + '(' + f.dataset_id + ')' : 'No dataset chosen. Use Discover to list the datasets in the workspace.'}>
              <div className="flex gap-2 flex-wrap items-center">
                <select id="pb-ds" className="input" value={f.dataset_id} onChange={(e) => set('dataset_id', e.target.value)} style={{ flex: 1, minWidth: 240, maxWidth: 420 }}>
                  {!picked && <option value={f.dataset_id}>{f.dataset_id ? (s['powerbi.dataset_name'] || f.dataset_id) + ' (current)' : 'Choose a dataset'}</option>}
                  {(datasets || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <Button variant="secondary" onClick={discover} disabled={discovering || dirty}>{discovering ? 'Discovering' : 'Discover'}</Button>
              </div>
              {dirty && <p className="t-small text-muted m-0" style={{ marginTop: 4 }}>Save changes first. Discover uses the saved sign-in settings.</p>}
            </Field>

            <Field label="Tables" hint="Each row is a table name or a full DAX query starting with EVALUATE. Blank skips that table and keeps the lookup rows of the current dataset.">
              <div role="table" aria-label="Power BI tables" style={{ border: '1px solid var(--line)', borderRadius: 8 }}>
                {TABLE_KEYS.map((t, i) => {
                  const r = resultByKey[t.key];
                  return (
                    <div role="row" key={t.key} className="flex items-center gap-3 flex-wrap" style={{ padding: '8px 12px', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                      <span role="cell" style={{ width: 110, fontWeight: 600 }}>{t.label}</span>
                      <span role="cell" style={{ flex: 1, minWidth: 220 }}>
                        <input className="input" aria-label={t.label + ' table name or DAX'} value={f.tables[t.key]} onChange={(e) => setTable(t.key, e.target.value)} style={FULL} spellCheck={false} placeholder="Skipped" />
                      </span>
                      <span role="cell" style={{ minWidth: 150 }} className="t-small">
                        {r ? (r.ok ? <StatusChip status="pass">{count(r.rows)} rows</StatusChip> : <span style={{ color: 'var(--fail)' }}>{r.error}</span>) : <span className="text-muted">Not tested</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Field>

            <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <Field label="Months back" htmlFor="pb-mb" hint="1 to 60. Usage is pulled one month at a time."><input id="pb-mb" className="input num" type="number" min="1" max="60" value={f.months_back} onChange={(e) => set('months_back', e.target.value)} style={FULL} /></Field>
              <Field label="Daily pull time" htmlFor="pb-sch" hint="Phoenix time, HH:MM. Blank turns the schedule off."><input id="pb-sch" className="input num" type="time" value={f.schedule} onChange={(e) => set('schedule', e.target.value)} style={FULL} /></Field>
            </div>
            <Field label="Promotion" hint="When on, a pull goes live as soon as it does not fail verification. A failed pull stays verified for a person to promote.">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.auto_promote} onChange={(e) => set('auto_promote', e.target.checked)} /> Promote automatically</label>
            </Field>
          </>
        )}
        {on && (
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 16 }}>
            <Button variant="secondary" onClick={runTest} disabled={testing || !canAct}>{testing ? 'Testing' : 'Test connection'}</Button>
            <Button variant="secondary" onClick={() => setAsk(true)} disabled={pulling || !canAct || !s['powerbi.dataset_id']}>{pulling ? 'Pulling' : 'Pull now'}</Button>
            {!canAct && <span className="t-small text-muted self-center">Save changes before testing or pulling.</span>}
          </div>
        )}
        {on && <p className="t-small text-muted m-0" style={{ marginTop: 12 }}>The tenant setting "Service principals can use Fabric APIs" must allow this app. The service principal also needs the Member or Contributor role on the workspace.</p>}
      </SectionCard>

      {on && test && <Card title="Connection test" caption={test.ok ? 'Every check passed.' : 'One or more checks failed.'}><Checklist r={test} /></Card>}
      {on && progress && <ProgressPanel p={progress} onDismiss={() => setProgress(null)} />}
      {on && (
        <Card title="Last pull">
          {status.last_pull_at ? (
            <dl className="grid gap-x-4 gap-y-2 m-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
              <div><dt className="t-small text-muted">When</dt><dd className="m-0 num">{when(status.last_pull_at)}</dd></div>
              <div><dt className="t-small text-muted">Verdict</dt><dd className="m-0">{status.last_pull && status.last_pull.verdict ? <StatusChip status={status.last_pull.verdict} /> : <span className="text-muted">n/a</span>}</dd></div>
              <div><dt className="t-small text-muted">Rows</dt><dd className="m-0 num">{status.last_pull ? count(status.last_pull.rows || 0) : 'n/a'}</dd></div>
              <div><dt className="t-small text-muted">Duration</dt><dd className="m-0 num">{status.last_pull ? seconds(status.last_pull.duration_ms) : 'n/a'}</dd></div>
              <div><dt className="t-small text-muted">Next scheduled run</dt><dd className="m-0 num">{status.schedule && status.next_run_at ? when(status.next_run_at) : 'Not scheduled'}</dd></div>
            </dl>
          ) : <p className="m-0 text-muted">No pull has run yet.{status.schedule && status.next_run_at ? ' Next scheduled run ' + when(status.next_run_at) + '.' : ''}</p>}
          {status.last_pull && status.last_pull.error && <p role="alert" className="m-0" style={{ marginTop: 8, color: 'var(--fail)' }}>{status.last_pull.error}</p>}
        </Card>
      )}

      <Dialog open={ask} onClose={() => setAsk(false)} title="Pull from Power BI?"
        footer={(<><Button variant="secondary" onClick={() => setAsk(false)}>Cancel</Button><Button onClick={startPull}>Pull now</Button></>)}>
        <p className="m-0">This reads {f.months_back} months of usage plus people and lookups from the chosen dataset and builds a new dataset. {f.auto_promote ? 'If verification does not fail it becomes the current dataset and the one in use is archived.' : 'It stays staged until you promote it from Data quality.'} A full pull can take several minutes.</p>
      </Dialog>
    </div>
  );
}

export default function DataSourceSection() {
  const q = useQuery('/settings', {});
  const st = useQuery('/powerbi/status', {}, { events: ['import.*', 'settings.changed', 'dataset.*'] });
  return (
    <DataState q={q} skeleton={<SkeletonCard height={320} />}>
      {(s) => <DataState q={st} skeleton={<SkeletonCard height={320} />}>{(status) => <Form s={s} status={status} reloadStatus={st.reload} />}</DataState>}
    </DataState>
  );
}
