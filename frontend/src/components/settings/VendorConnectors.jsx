import React, { useEffect, useRef, useState } from 'react';
import DataState from '../DataState.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import Dialog from '../ui/Dialog.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { useToast } from '../ui/Toast.jsx';
import Card from '../charts/Card.jsx';
import { SectionCard, Field, useSaver } from './shared.jsx';
import { SecretField, ProgressPanel } from './DataSourceSection.jsx';
import { useQuery } from '../../lib/query.js';
import { useLiveRefresh } from '../../lib/live.jsx';
import { api, isMock } from '../../lib/api.js';
import { count, money } from '../../lib/format.js';

const STAGES = ['auth', 'usage', 'carry', 'people', 'lookups', 'normalize', 'verify', 'promote', 'done'];
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

function VendorChecklist({ r }) {
  return (
    <ul className="list-none p-0 m-0" style={{ borderTop: '1px solid var(--line)', marginTop: 12 }} aria-label="Connection test steps">
      {(r.steps || []).map((st) => (
        <li key={st.key} className="flex items-center gap-3 flex-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <StatusChip status={st.ok ? 'pass' : 'fail'}>{st.ok ? 'OK' : 'Failed'}</StatusChip>
          <span style={{ fontWeight: 600, minWidth: 110 }}>{st.label}</span>
          <span className="t-small text-muted" style={{ flex: 1 }}>{st.detail}</span>
        </li>
      ))}
      {r.duration_ms !== undefined && <li className="t-small text-muted" style={{ padding: '6px 0' }}>Finished in {seconds(r.duration_ms)}.</li>}
    </ul>
  );
}

function statusOf(c, last) {
  if (!c.configured) return { tone: 'warn', text: 'Not configured' };
  const failed = last && last.error && (String(last.error).includes(c.id) || String(last.error).includes(c.label));
  if (failed) return { tone: 'fail', text: 'Last pull failed' };
  if (last && last.by_vendor && last.by_vendor[c.id]) return { tone: 'ok', text: 'Last pull ok' };
  return { tone: 'accent', text: 'Ready' };
}

// One card per connector. Only Anthropic has fields so far; the keys are prefixed by connector id.
function ConnectorCard({ c, s, last, busy, onPull }) {
  const toast = useToast();
  const { save, saving } = useSaver();
  const k = (name) => c.id + '.' + name;
  const base = {
    enabled: !!s[k('enabled')],
    rebuild_days: String(s[k('rebuild_days')] === undefined ? 9 : s[k('rebuild_days')]),
    base_url: s[k('base_url')] || '',
    version: s[k('anthropic_version')] || ''
  };
  const [f, setF] = useState(base);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const sig = JSON.stringify(base);
  useEffect(() => { setF(base); setKey(''); setClearKey(false); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (n, v) => setF((o) => ({ ...o, [n]: v }));

  const patch = {};
  if (f.enabled !== base.enabled) patch[k('enabled')] = f.enabled;
  if (f.rebuild_days !== base.rebuild_days) patch[k('rebuild_days')] = Number(f.rebuild_days);
  if (f.base_url.trim() !== base.base_url) patch[k('base_url')] = f.base_url.trim();
  if (f.version.trim() !== base.version) patch[k('anthropic_version')] = f.version.trim();
  if (clearKey) patch[k('api_key')] = null;
  else if (key !== '') patch[k('api_key')] = key;
  const dirty = Object.keys(patch).length > 0;
  const rd = Number(f.rebuild_days);
  const urlOk = /^https?:\/\/\S+$/.test(f.base_url.trim());
  const valid = Number.isInteger(rd) && rd >= 1 && rd <= 31 && urlOk && f.version.trim() !== '';
  const stored = isSet(s[k('api_key')]) && !clearKey;
  const st = statusOf(c, last);
  const floor = s[k('history_floor')] || c.history_floor || '2026-01-01';

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await api.post('/vendors/' + c.id + '/test', {});
      setTest(r);
      if (r.ok) toast.success('Connection works'); else toast.error('The connection test found problems');
    } catch (e) { toast.error(e.message || 'Test failed'); setTest(null); } finally { setTesting(false); }
  };

  return (
    <SectionCard id={'vendor-' + c.id} title={c.label} caption={'Usage rows land on the ' + c.platform + ' platform.'}
      dirty={dirty} saving={saving} disabled={!valid}
      onSave={() => save(() => api.put('/settings', { patch }), c.label + ' settings saved')}
      extra={<Chip tone={st.tone}>{st.text}</Chip>}>
      <Field label="Connector" hint={f.enabled ? 'Included when Pull now runs for every enabled connector.' : 'Off. Settings stay saved but this connector is skipped.'}>
        <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled</label>
      </Field>
      {!c.configured && c.problems && c.problems.length > 0 && <p className="t-small text-muted m-0" style={{ marginBottom: 12 }}>Missing: {c.problems.join(', ')}.</p>}
      <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div>
          <SecretField id={'vc-key-' + c.id} label="API key" stored={stored} value={key} onChange={(v) => { setKey(v); setClearKey(false); }}
            hint="Analytics key, starts with sk-ant-api01-." />
          {isSet(s[k('api_key')]) && (
            <div style={{ marginTop: -4, marginBottom: 12 }}>
              <label className="inline-flex items-center gap-2 t-small"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setKey(''); }} /> Remove the stored key on save</label>
            </div>
          )}
        </div>
        <Field label="Re-pull days" htmlFor={'vc-rebuild-' + c.id} hint="1 to 31. Recent days are fetched again because the vendor revises them for about a week.">
          <input id={'vc-rebuild-' + c.id} className="input num" type="number" min="1" max="31" value={f.rebuild_days} onChange={(e) => set('rebuild_days', e.target.value)} style={FULL} />
        </Field>
      </div>
      <p className="t-small text-muted m-0" style={{ marginBottom: 12 }}>Data is available from {floor}.</p>
      <details style={{ marginBottom: 12 }}>
        <summary className="t-small" style={{ cursor: 'pointer', fontWeight: 600 }}>Advanced</summary>
        <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 8 }}>
          <Field label="Base URL" htmlFor={'vc-url-' + c.id} hint="Change only to reach the API through a proxy.">
            <input id={'vc-url-' + c.id} className="input num" value={f.base_url} onChange={(e) => set('base_url', e.target.value)} style={FULL} spellCheck={false} aria-invalid={!urlOk} />
          </Field>
          <Field label="API version" htmlFor={'vc-ver-' + c.id} hint="Sent as the anthropic-version header.">
            <input id={'vc-ver-' + c.id} className="input num" value={f.version} onChange={(e) => set('version', e.target.value)} style={FULL} spellCheck={false} />
          </Field>
        </div>
      </details>
      <p className="t-small text-muted m-0">The primary owner of the Enterprise organization creates the Analytics key at claude.ai under Organization settings, API. The key needs the read:analytics scope, and read:rbac_groups adds team mapping.</p>
      <div className="flex gap-2 flex-wrap items-center" style={{ marginTop: 16 }}>
        <Button variant="secondary" onClick={runTest} disabled={testing || dirty}>{testing ? 'Testing' : 'Test connection'}</Button>
        <Button variant="secondary" onClick={() => onPull([c.id])} disabled={busy || dirty || !f.enabled || !c.configured}>Pull this connector only</Button>
        {dirty && <span className="t-small text-muted">Save changes before testing or pulling.</span>}
      </div>
      {test && (
        <div style={{ marginTop: 12 }}>
          <StatusChip status={test.ok ? 'pass' : 'fail'}>{test.ok ? 'Every check passed' : 'One or more checks failed'}</StatusChip>
          <VendorChecklist r={test} />
        </div>
      )}
    </SectionCard>
  );
}

function Panel({ s, data, reload }) {
  const toast = useToast();
  const { save, saving } = useSaver();
  const base = {
    schedule: data.schedule || '',
    auto_promote: data.auto_promote !== false,
    months_back: String(data.months_back === undefined ? 13 : data.months_back)
  };
  const [f, setF] = useState(base);
  const [ask, setAsk] = useState(null); // ids to pull, [] = every enabled connector
  const [progress, setProgress] = useState(null);
  const [pulling, setPulling] = useState(false);
  const pullingRef = useRef(false);
  const lastStage = useRef('auth');
  const timers = useRef([]);
  const sig = JSON.stringify(base);
  useEffect(() => { setF(base); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  pullingRef.current = pulling;

  const patch = {};
  if (f.schedule !== base.schedule) patch['vendors.schedule'] = f.schedule;
  if (f.auto_promote !== base.auto_promote) patch['vendors.auto_promote'] = f.auto_promote;
  if (f.months_back !== base.months_back) patch['vendors.months_back'] = Number(f.months_back);
  const dirty = Object.keys(patch).length > 0;
  const mb = Number(f.months_back);
  const valid = Number.isInteger(mb) && mb >= 1 && mb <= 60 && timeOk(f.schedule);

  const connectors = data.connectors || [];
  const enabled = connectors.filter((c) => c.enabled && c.configured);
  const last = data.last_pull;
  const busy = pulling || !!data.running;

  const onEvent = (ev) => {
    if (!ev || ev.type !== 'import.progress') return;
    if (!pullingRef.current && !ev.vendor) return;
    if (ev.stage && ev.stage !== 'error') lastStage.current = ev.stage;
    setProgress((p) => {
      const vendors = { ...((p && p.vendors) || {}) };
      if (ev.vendor) vendors[ev.vendor] = ev.stage;
      return { ...(p || {}), ...ev, vendors, lastStage: lastStage.current };
    });
    if (ev.stage === 'done') { setPulling(false); toast.success('Vendor pull finished'); reload(); }
    if (ev.stage === 'error') setPulling(false);
  };
  useLiveRefresh(['import.*'], onEvent);

  const startPull = async (ids) => {
    setAsk(null);
    setPulling(true);
    lastStage.current = 'auth';
    const names = ids.length ? ids : enabled.map((c) => c.id);
    setProgress({ stage: 'auth', rows: 0, table: '', chunk: null, message: 'Starting', lastStage: 'auth', vendors: {} });
    if (isMock) { // no backend and no event stream in mock mode: replay the stages locally
      let rows = 0;
      STAGES.forEach((st, i) => {
        timers.current.push(setTimeout(() => {
          rows += st === 'usage' ? 38000 : st === 'people' ? 400 : 0;
          const vendor = ['auth', 'usage', 'people'].includes(st) ? (names[0] || 'anthropic') : undefined;
          onEvent({ type: 'import.progress', stage: st, vendor, table: st === 'usage' ? 'usage' : '', chunk: null, rows, message: st === 'done' ? 'Mock pull complete' : '' });
        }, 600 * (i + 1)));
      });
      return;
    }
    try {
      const r = await api.post('/vendors/pull', ids.length ? { ids } : {});
      onEvent({ type: 'import.progress', stage: 'done', rows: r.rows, message: 'Verdict ' + r.verdict + (r.promoted ? ', promoted' : ', not promoted') });
    } catch (e) {
      setPulling(false);
      if (e.status === 409) { toast.error('A pull is already running'); setProgress(null); return; }
      onEvent({ type: 'import.progress', stage: 'error', message: e.message || 'The pull failed' });
    }
  };

  const byVendor = last && last.by_vendor ? Object.keys(last.by_vendor).map((id) => ({ id, ...last.by_vendor[id] })) : [];
  const askNames = ask && ask.length ? ask.join(', ') : enabled.map((c) => c.id).join(', ');

  return (
    <>
      <SectionCard id="vendors" title="Vendor connectors" caption="Pull usage straight from each vendor. Platforms without a connector keep the rows from the last Power BI or CSV load."
        dirty={dirty} saving={saving} disabled={!valid}
        onSave={() => save(() => api.put('/settings', { patch }), 'Vendor settings saved')}>
        <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <Field label="Months back" htmlFor="vc-mb" hint="1 to 60. Applies to the first pull of a platform."><input id="vc-mb" className="input num" type="number" min="1" max="60" value={f.months_back} onChange={(e) => set('months_back', e.target.value)} style={FULL} /></Field>
          <Field label="Daily pull time" htmlFor="vc-sch" hint="Phoenix time, HH:MM. Blank turns the schedule off."><input id="vc-sch" className="input num" type="time" value={f.schedule} onChange={(e) => set('schedule', e.target.value)} style={FULL} /></Field>
        </div>
        <Field label="Promotion" hint="When on, a pull goes live as soon as it does not fail verification. A failed pull stays verified for a person to promote.">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.auto_promote} onChange={(e) => set('auto_promote', e.target.checked)} /> Promote automatically</label>
        </Field>
        <div className="flex gap-2 flex-wrap items-center" style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={() => setAsk([])} disabled={busy || dirty || enabled.length === 0}>{busy ? 'Pulling' : 'Pull now'}</Button>
          {dirty && <span className="t-small text-muted">Save changes before pulling.</span>}
          {!dirty && enabled.length === 0 && <span className="t-small text-muted">Enable and configure a connector to pull.</span>}
        </div>
      </SectionCard>

      {progress && <ProgressPanel p={progress} onDismiss={() => setProgress(null)} stages={STAGES} source="the vendors" />}

      <Card title="Last vendor pull">
        {data.last_pull_at ? (
          <>
            <dl className="grid gap-x-4 gap-y-2 m-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
              <div><dt className="t-small text-muted">When</dt><dd className="m-0 num">{when(data.last_pull_at)}</dd></div>
              <div><dt className="t-small text-muted">Verdict</dt><dd className="m-0">{last && last.verdict ? <StatusChip status={last.verdict} /> : <span className="text-muted">n/a</span>}</dd></div>
              <div><dt className="t-small text-muted">Rows</dt><dd className="m-0 num">{last ? count(last.rows || 0) : 'n/a'}</dd></div>
              <div><dt className="t-small text-muted">Duration</dt><dd className="m-0 num">{last ? seconds(last.duration_ms) : 'n/a'}</dd></div>
              <div><dt className="t-small text-muted">Next scheduled run</dt><dd className="m-0 num">{data.schedule && data.next_run_at ? when(data.next_run_at) : 'Not scheduled'}</dd></div>
            </dl>
            {byVendor.length > 0 && (
              <table className="tbl compact" aria-label="Last pull by vendor" style={{ marginTop: 12 }}>
                <thead><tr><th>Vendor</th><th className="r">Rows</th><th className="r">Spend</th><th>From</th><th>To</th><th>Data refreshed</th><th>Coverage</th></tr></thead>
                <tbody>
                  {byVendor.map((v) => (
                    <tr key={v.id}>
                      <td>{v.id}</td>
                      <td className="r num">{count(v.rows || 0)}</td>
                      <td className="r num">{money(v.usd || 0)}</td>
                      <td className="num">{v.from || 'n/a'}</td>
                      <td className="num">{v.to || 'n/a'}</td>
                      <td className="num">{v.data_refreshed_at ? when(v.data_refreshed_at) : 'n/a'}</td>
                      <td className="num">{v.coverage === undefined || v.coverage === null ? 'n/a' : (typeof v.coverage === 'number' ? Math.round(v.coverage * 100) + '%' : JSON.stringify(v.coverage))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : <p className="m-0 text-muted">No vendor pull has run yet.{data.schedule && data.next_run_at ? ' Next scheduled run ' + when(data.next_run_at) + '.' : ''}</p>}
        {last && last.error && <p role="alert" className="m-0" style={{ marginTop: 8, color: 'var(--fail)' }}>{last.error}</p>}
      </Card>

      {connectors.map((c) => <ConnectorCard key={c.id} c={c} s={s} last={last} busy={busy} onPull={(ids) => setAsk(ids)} />)}

      <Dialog open={ask !== null} onClose={() => setAsk(null)} title="Pull from vendors?"
        footer={(<><Button variant="secondary" onClick={() => setAsk(null)}>Cancel</Button><Button onClick={() => startPull(ask || [])}>Pull now</Button></>)}>
        <p className="m-0">This pulls usage from {askNames || 'the enabled connectors'} and builds a new dataset. Platforms without a connector keep their current rows. {f.auto_promote ? 'If verification does not fail it becomes the current dataset and the one in use is archived.' : 'It stays staged until you promote it from Data quality.'}</p>
      </Dialog>
    </>
  );
}

export default function VendorConnectors({ s }) {
  const q = useQuery('/vendors', {}, { events: ['import.*', 'settings.changed', 'dataset.*'] });
  return <DataState q={q} skeleton={<SkeletonCard height={200} />}>{(data) => <Panel s={s} data={data} reload={q.reload} />}</DataState>;
}
