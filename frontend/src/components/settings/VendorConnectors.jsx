import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import Dialog from '../ui/Dialog.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { useToast } from '../ui/Toast.jsx';
import Card from '../charts/Card.jsx';
import { SectionCard, Field, useSaver } from './shared.jsx';
import { SecretField, ProgressPanel } from './DataSourceSection.jsx';
import { TabPane } from '../ui/TabStrip.jsx';
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

// Starting value of one field, from the settings map (secrets are {set} markers and start blank).
function startValue(fd, s) {
  const v = s[fd.key];
  if (fd.type === 'secret') return '';
  if (fd.type === 'boolean') return v === undefined ? !!fd.default : !!v;
  if (v === undefined || v === null) return fd.default === undefined ? '' : String(fd.default);
  return String(v);
}

function fieldError(fd, v) {
  if (fd.type === 'number') {
    if (v === '' || v === undefined) return fd.required ? 'Required' : '';
    const n = Number(v);
    if (!Number.isFinite(n)) return 'Enter a number';
    if (fd.min !== undefined && n < fd.min) return 'At least ' + fd.min;
    if (fd.max !== undefined && n > fd.max) return 'At most ' + fd.max;
    return '';
  }
  if (fd.type === 'text' || fd.type === 'textarea' || fd.type === 'select') return fd.required && String(v).trim() === '' ? 'Required' : '';
  return '';
}

function ActionPanel({ c, a, disabled }) {
  const toast = useToast();
  const [flow, setFlow] = useState(null); // {user_code, verification_uri, expires_in, message}
  const [state, setState] = useState(null); // {state, detail}
  const [starting, setStarting] = useState(false);
  const timer = useRef(null);
  const path = '/vendors/' + c.id + '/actions/' + a.key;
  useEffect(() => () => clearTimeout(timer.current), []);
  const poll = () => {
    timer.current = setTimeout(async () => {
      try {
        const r = await api.get(path);
        setState(r);
        if (r.state === 'pending') poll();
        else if (r.state === 'done') toast.success('Signed in');
      } catch (e) { setState({ state: 'error', detail: e.message || 'Status check failed' }); }
    }, 5000);
  };
  const start = async () => {
    clearTimeout(timer.current);
    setStarting(true);
    setState(null);
    try {
      const r = await api.post(path, {});
      setFlow(r);
      setState({ state: 'pending' });
      poll();
    } catch (e) { setFlow(null); toast.error(e.message || 'Could not start the sign-in'); } finally { setStarting(false); }
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <Button variant="secondary" onClick={start} disabled={disabled || starting}>{starting ? 'Starting' : a.label || 'Sign in as administrator'}</Button>
      {disabled && <span className="t-small text-muted" style={{ marginLeft: 8 }}>Save changes first.</span>}
      {flow && (
        <div role="status" aria-live="polite" style={{ marginTop: 12, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
          <p className="t-small text-muted m-0">Open <a href={flow.verification_uri} target="_blank" rel="noreferrer noopener">{flow.verification_uri}</a> and enter this code.</p>
          <p className="num m-0" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '0.12em', margin: '6px 0' }} data-testid="device-code">{flow.user_code}</p>
          {flow.message && <p className="t-small text-muted m-0">{flow.message}</p>}
          <p className="t-small m-0" style={{ marginTop: 8 }}>
            {state && state.state === 'done' && <><StatusChip status="pass">Signed in</StatusChip> <span>{state.detail}</span></>}
            {state && state.state === 'error' && <><StatusChip status="fail">Failed</StatusChip> <span>{state.detail}</span></>}
            {(!state || state.state === 'pending') && <span className="text-muted">Waiting for you to finish signing in. The code expires in {Math.round((flow.expires_in || 0) / 60)} min.</span>}
          </p>
        </div>
      )}
    </div>
  );
}

// One card per connector. Every field comes from c.describe.fields; the keys are full settings keys.
function ConnectorCard({ c, s, last, busy, onPull }) {
  const toast = useToast();
  const { save, saving } = useSaver();
  const d = c.describe || {};
  const fields = d.fields || [];
  const base = {};
  fields.forEach((fd) => { base[fd.key] = startValue(fd, s); });
  base[c.id + '.enabled'] = !!s[c.id + '.enabled'];
  const [f, setF] = useState(base);
  const [clear, setClear] = useState({});
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const sig = JSON.stringify(base);
  useEffect(() => { setF(base); setClear({}); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (n, v) => setF((o) => ({ ...o, [n]: v }));

  const patch = {};
  if (f[c.id + '.enabled'] !== base[c.id + '.enabled']) patch[c.id + '.enabled'] = f[c.id + '.enabled'];
  const errors = {};
  fields.forEach((fd) => {
    const v = f[fd.key];
    if (fd.type === 'secret') {
      if (clear[fd.key]) patch[fd.key] = null;
      else if (v !== '' && v !== undefined) patch[fd.key] = v;
      return;
    }
    const err = fieldError(fd, v);
    if (err) errors[fd.key] = err;
    if (v === base[fd.key]) return;
    if (fd.type === 'number') patch[fd.key] = v === '' ? null : Number(v);
    else if (fd.type === 'boolean') patch[fd.key] = !!v;
    else patch[fd.key] = typeof v === 'string' ? v.trim() : v;
  });
  const dirty = Object.keys(patch).length > 0;
  const valid = Object.keys(errors).length === 0;
  const st = statusOf(c, last);
  const floor = s[c.id + '.history_floor'] || c.history_floor || d.history_floor;
  const enabled = f[c.id + '.enabled'];
  const normal = fields.filter((fd) => !fd.advanced);
  const advanced = fields.filter((fd) => fd.advanced);
  const actions = (d.actions || []).filter((a) => a.kind === 'devicecode');

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await api.post('/vendors/' + c.id + '/test', {});
      setTest(r);
      if (r.ok) toast.success('Connection works'); else toast.error('The connection test found problems');
    } catch (e) { toast.error(e.message || 'Test failed'); setTest(null); } finally { setTesting(false); }
  };

  const id = (fd) => 'vc-' + c.id + '-' + fd.key.replace(/[^a-z0-9]+/gi, '-');
  const hintOf = (fd) => (errors[fd.key] ? errors[fd.key] + (fd.hint ? '. ' + fd.hint : '') : fd.hint);
  const render = (fd) => {
    const v = f[fd.key];
    const bad = !!errors[fd.key];
    if (fd.type === 'secret') {
      const stored = isSet(s[fd.key]) && !clear[fd.key];
      return (
        <div key={fd.key}>
          <SecretField id={id(fd)} label={fd.label} stored={stored} value={v || ''} hint={fd.hint}
            onChange={(nv) => { set(fd.key, nv); setClear((o) => ({ ...o, [fd.key]: false })); }} />
          {isSet(s[fd.key]) && (
            <div style={{ marginTop: -4, marginBottom: 12 }}>
              <label className="inline-flex items-center gap-2 t-small"><input type="checkbox" checked={!!clear[fd.key]}
                onChange={(e) => { setClear((o) => ({ ...o, [fd.key]: e.target.checked })); if (e.target.checked) set(fd.key, ''); }} /> Remove the stored key on save</label>
            </div>
          )}
        </div>
      );
    }
    if (fd.type === 'boolean') {
      return (
        <Field key={fd.key} label={fd.label} hint={fd.hint}>
          <label className="inline-flex items-center gap-2"><input id={id(fd)} type="checkbox" checked={!!v} onChange={(e) => set(fd.key, e.target.checked)} /> {v ? 'On' : 'Off'}</label>
        </Field>
      );
    }
    let input;
    if (fd.type === 'select') {
      input = (
        <select id={id(fd)} className="input" value={v} onChange={(e) => set(fd.key, e.target.value)} style={FULL}>
          {!(fd.options || []).some((o) => o.value === v) && <option value={v}>{v === '' ? 'Choose' : v}</option>}
          {(fd.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    } else if (fd.type === 'textarea') {
      input = <textarea id={id(fd)} className="input" rows={4} value={v} placeholder={fd.placeholder} onChange={(e) => set(fd.key, e.target.value)} style={{ ...FULL, resize: 'vertical' }} spellCheck={false} aria-invalid={bad} />;
    } else if (fd.type === 'number') {
      input = <input id={id(fd)} className="input num" type="number" min={fd.min} max={fd.max} value={v} placeholder={fd.placeholder} onChange={(e) => set(fd.key, e.target.value)} style={FULL} aria-invalid={bad} />;
    } else {
      input = <input id={id(fd)} className="input num" value={v} placeholder={fd.placeholder} onChange={(e) => set(fd.key, e.target.value)} style={FULL} spellCheck={false} aria-invalid={bad} />;
    }
    return <Field key={fd.key} label={fd.label} htmlFor={id(fd)} hint={hintOf(fd)}>{input}</Field>;
  };
  const GRID = { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' };

  return (
    <SectionCard id={'vendor-' + c.id} title={c.label} caption={'Usage rows land on the ' + c.platform + ' platform.'}
      dirty={dirty} saving={saving} disabled={!valid}
      onSave={() => save(() => api.put('/settings', { patch }), c.label + ' settings saved')}
      extra={<Chip tone={st.tone}>{st.text}</Chip>}>
      <Field label="Connector" hint={enabled ? 'Included when Pull now runs for every enabled connector.' : 'Off. Settings stay saved but this connector is skipped.'}>
        <label className="inline-flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => set(c.id + '.enabled', e.target.checked)} /> Enabled</label>
      </Field>
      {!c.configured && c.problems && c.problems.length > 0 && <p className="t-small text-muted m-0" style={{ marginBottom: 12 }}>Missing: {c.problems.join(', ')}.</p>}
      <div className="grid gap-x-4" style={GRID}>{normal.map(render)}</div>
      {actions.map((a) => <ActionPanel key={a.key} c={c} a={a} disabled={dirty} />)}
      {floor && <p className="t-small text-muted m-0" style={{ marginBottom: 12 }}>Data is available from {floor}.</p>}
      {advanced.length > 0 && (
        <details style={{ marginBottom: 12 }}>
          <summary className="t-small" style={{ cursor: 'pointer', fontWeight: 600 }}>Advanced</summary>
          <div className="grid gap-x-4" style={{ ...GRID, marginTop: 8 }}>{advanced.map(render)}</div>
        </details>
      )}
      <p className="t-small text-muted m-0" style={{ marginBottom: 8 }}>Addresses, ports and permissions are on the <Link to={'/help?tab=' + c.id}>Help page</Link>.</p>
      {(d.help || []).map((h, i) => <p key={i} className="t-small text-muted m-0" style={{ marginBottom: 4 }}>{h}</p>)}
      <div className="flex gap-2 flex-wrap items-center" style={{ marginTop: 16 }}>
        <Button variant="secondary" onClick={runTest} disabled={testing || dirty}>{testing ? 'Testing' : 'Test connection'}</Button>
        <Button variant="secondary" onClick={() => onPull([c.id])} disabled={busy || dirty || !enabled || !c.configured}>Pull this connector only</Button>
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

function Panel({ s, data, reload, tab }) {
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
      {progress && <ProgressPanel p={progress} onDismiss={() => setProgress(null)} stages={STAGES} source="the vendors" />}
      <TabPane id="vendors" idPrefix="ds" active={tab === 'vendors'}>
      <div className="stack-32">
      <SectionCard id="vendors" title="Vendor pulls" caption="Pull usage straight from each vendor. Platforms without a connector keep the rows from the last Power BI or CSV load."
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

      </div>
      </TabPane>
      {connectors.map((c) => (
        <TabPane key={c.id} id={c.id} idPrefix="ds" active={tab === c.id}>
          <ConnectorCard c={c} s={s} last={last} busy={busy} onPull={(ids) => setAsk(ids)} />
        </TabPane>
      ))}

      <Dialog open={ask !== null} onClose={() => setAsk(null)} title="Pull from vendors?"
        footer={(<><Button variant="secondary" onClick={() => setAsk(null)}>Cancel</Button><Button onClick={() => startPull(ask || [])}>Pull now</Button></>)}>
        <p className="m-0">This pulls usage from {askNames || 'the enabled connectors'} and builds a new dataset. Platforms without a connector keep their current rows. {f.auto_promote ? 'If verification does not fail it becomes the current dataset and the one in use is archived.' : 'It stays staged until you promote it from Data quality.'}</p>
      </Dialog>
    </>
  );
}

// Rendered by DataSourceSection, which loads /vendors and owns the tab strip.
export default function VendorPanes({ s, data, reload, tab }) {
  return <Panel s={s} data={data} reload={reload} tab={tab} />;
}
