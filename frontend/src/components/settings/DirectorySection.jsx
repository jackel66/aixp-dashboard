import React, { useEffect, useState } from 'react';
import { RequirementsFold } from '../help/IntegrationBlocks.jsx';
import DataState from '../DataState.jsx';
import Card from '../charts/Card.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { useToast } from '../ui/Toast.jsx';
import { SectionCard, Field } from './shared.jsx';
import { ACCESS_EVENTS, whenText } from './access.js';
import { useQuery } from '../../lib/query.js';
import { api } from '../../lib/api.js';

const TLS = [{ value: 'auto', label: 'Auto' }, { value: 'ldaps', label: 'LDAPS' }, { value: 'starttls', label: 'StartTLS' }];
const FULL = { width: '100%' };
const isSet = (v) => !!(v && typeof v === 'object' && v.set);

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

function Checklist({ steps }) {
  return (
    <ul className="list-none p-0 m-0" style={{ borderTop: '1px solid var(--line)' }}>
      {steps.map((s) => (
        <li key={s.key} className="flex items-center gap-3 flex-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <StatusChip status={s.ok ? 'pass' : 'fail'}>{s.ok ? 'OK' : 'Failed'}</StatusChip>
          <span style={{ fontWeight: 600, minWidth: 150 }}>{s.label}</span>
          <span className="t-small text-muted" style={{ flex: 1, minWidth: 200, wordBreak: 'break-word' }}>{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const listText = (v) => (Array.isArray(v) ? v.join(', ') : v || '');

function Form({ data, reload }) {
  const toast = useToast();
  const cfg = data.config || {};
  const g = (k, d) => { const v = cfg['ad.' + k] !== undefined ? cfg['ad.' + k] : cfg[k]; return v === undefined || v === null ? d : v; };
  const base = {
    enabled: !!g('enabled', false),
    domain: String(g('domain', '')),
    bind_user: String(g('bind_user', '')),
    servers: listText(g('servers', '')),
    base_dn: String(g('base_dn', '')),
    tls_mode: String(g('tls_mode', 'auto')),
    tls_verify: g('tls_verify', true) !== false,
    ca_cert: String(g('ca_cert', '')),
    sync_minutes: String(g('sync_minutes', 60)),
    deactivate_removed: g('deactivate_removed', true) !== false
  };
  const stored = isSet(g('bind_password', null));
  const [f, setF] = useState(base);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [test, setTest] = useState(null);
  const [sync, setSync] = useState(null);
  const sig = JSON.stringify(base);
  useEffect(() => { setF(base); setSecret(''); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));

  const patch = {};
  ['domain', 'bind_user', 'servers', 'base_dn', 'ca_cert'].forEach((k) => { if (f[k].trim() !== base[k]) patch['ad.' + k] = f[k].trim(); });
  ['enabled', 'tls_verify', 'deactivate_removed', 'tls_mode'].forEach((k) => { if (f[k] !== base[k]) patch['ad.' + k] = f[k]; });
  if (f.sync_minutes !== base.sync_minutes) patch['ad.sync_minutes'] = Number(f.sync_minutes);
  if (secret !== '') patch['ad.bind_password'] = secret;
  const dirty = Object.keys(patch).length > 0;
  const sm = Number(f.sync_minutes);
  const valid = Number.isInteger(sm) && sm >= 5 && sm <= 1440 && (!f.enabled || (f.domain.trim() && f.bind_user.trim()));

  const doSave = async () => {
    if (dirty) await api.put('/access/directory', patch);
  };
  const save = async () => {
    setSaving(true);
    try { await doSave(); toast.success('Directory settings saved'); reload(); } catch (e) { toast.error(e.message || 'Could not save'); } finally { setSaving(false); }
  };
  const saveAndTest = async () => {
    setSaving(true);
    setTest(null);
    try {
      await doSave();
      setSaving(false);
      setTesting(true);
      const r = await api.post('/access/directory/test', {});
      setTest(r);
      if (r.ok) toast.success('Directory test passed'); else toast.error('The directory test found a problem');
      reload();
    } catch (e) { toast.error(e.message || 'Test failed'); } finally { setSaving(false); setTesting(false); }
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.post('/access/directory/sync', {});
      setSync(r);
      toast.success('Directory sync finished');
      reload();
    } catch (e) { toast.error(e.message || 'Sync failed'); } finally { setSyncing(false); }
  };

  const d = data.discovered || {};
  const st = data.status || {};
  const lastSync = sync || st.last_sync || null;
  const steps = test && Array.isArray(test.steps) ? test.steps : [];
  const busy = saving || testing;

  return (
    <div className="stack-32">
      <SectionCard id="directory" title="Active Directory" caption="Sign in with domain accounts and give roles to AD groups and organizational units. Off by default; local accounts always keep working."
        dirty={dirty} saving={saving} disabled={!valid} onSave={save} saveLabel="Save"
        extra={<Button variant="secondary" onClick={saveAndTest} disabled={busy || !valid || (!f.enabled && !base.enabled)}>{testing ? 'Testing' : 'Save and test'}</Button>}>
        <Field label="Status">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enable Active Directory sign-in</label>
        </Field>
        <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <Field label="Domain" htmlFor="ad-domain" hint="The DNS name, such as corp.example.com. Domain controllers and the base DN are found from it."><input id="ad-domain" className="input" value={f.domain} onChange={(e) => set('domain', e.target.value)} style={FULL} spellCheck={false} autoCapitalize="none" /></Field>
          <Field label="Service account" htmlFor="ad-bind" hint="A normal domain account that can read the directory. It needs no admin rights. Type it as name, DOMAIN\name or name@domain."><input id="ad-bind" className="input" value={f.bind_user} onChange={(e) => set('bind_user', e.target.value)} style={FULL} spellCheck={false} autoCapitalize="none" /></Field>
          <SecretField id="ad-pw" label="Service account password" stored={stored} value={secret} onChange={setSecret} hint="Stored encrypted. Leave blank to keep the stored one." />
        </div>

        <details style={{ marginTop: 8 }}>
          <summary className="cursor-pointer" style={{ fontWeight: 600 }}>Advanced</summary>
          <div style={{ marginTop: 12 }}>
            <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
              <Field label="Domain controllers" htmlFor="ad-servers" hint="Blank finds them in DNS. Otherwise list host names, separated by commas or spaces. Prefix ldaps:// or starttls:// to pin one transport; ldap:// sends passwords unencrypted."><input id="ad-servers" className="input" value={f.servers} onChange={(e) => set('servers', e.target.value)} style={FULL} spellCheck={false} /></Field>
              <Field label="Base DN" htmlFor="ad-basedn" hint="Blank derives it from the domain and confirms it with the directory."><input id="ad-basedn" className="input" value={f.base_dn} onChange={(e) => set('base_dn', e.target.value)} style={FULL} spellCheck={false} /></Field>
              <Field label="Sync every (minutes)" htmlFor="ad-sync" hint="5 to 1440. Refreshes groups, organizational units and disabled accounts."><input id="ad-sync" className="input num" type="number" min="5" max="1440" value={f.sync_minutes} onChange={(e) => set('sync_minutes', e.target.value)} style={FULL} /></Field>
            </div>
            <Field label="Connection security" hint="LDAPS needs a server certificate on the domain controller. Auto tries LDAPS first, then StartTLS.">
              <SegmentedControl label="Connection security" value={f.tls_mode} options={TLS} onChange={(v) => set('tls_mode', v)} />
            </Field>
            <Field label="Certificate">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.tls_verify} onChange={(e) => set('tls_verify', e.target.checked)} /> Verify the server certificate</label>
            </Field>
            <Field label="CA certificate" htmlFor="ad-ca" hint="Optional PEM text. Needed when the domain controller certificate comes from a private authority this server does not trust."><textarea id="ad-ca" className="input" rows={4} value={f.ca_cert} onChange={(e) => set('ca_cert', e.target.value)} style={{ ...FULL, height: 'auto', padding: 8, fontFamily: 'monospace' }} spellCheck={false} /></Field>
            <Field label="Removed accounts">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.deactivate_removed} onChange={(e) => set('deactivate_removed', e.target.checked)} /> Deactivate users that are disabled or gone in Active Directory</label>
            </Field>
          </div>
        </details>
        <RequirementsFold id="ad" />
        {!valid && <p className="t-small m-0" style={{ marginTop: 8, color: 'var(--fail)' }}>{f.enabled && !(f.domain.trim() && f.bind_user.trim()) ? 'Enter the domain and the service account to enable Active Directory.' : 'Sync minutes must be a whole number from 5 to 1440.'}</p>}
        {dirty && <p className="t-small text-muted m-0" style={{ marginTop: 8 }}>Save and test saves your changes first, then checks each step: DNS, connect, sign-in, base DN and counts. The test names the step that failed.</p>}
      </SectionCard>

      {test && (
        <Card title="Directory test" caption={(test.ok ? 'Every step passed' : 'A step failed') + (test.duration_ms ? ' in ' + (test.duration_ms / 1000).toFixed(1) + ' s.' : '.')}>
          <Checklist steps={steps} />
          <p className="t-small text-muted m-0" style={{ marginTop: 8 }}>A failed step names where the sign-in path broke. Find domain controllers: DNS has no record, list servers under Advanced. Connect: no controller answered, or LDAPS has no certificate. Sign in: the service account name or password was refused.</p>
        </Card>
      )}

      <Card title="Discovered and status" caption="What the app worked out from the domain name, and how the last test and sync went.">
        <dl className="grid gap-x-4 gap-y-3 m-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <div><dt className="t-small text-muted">Domain controllers</dt><dd className="m-0" style={{ wordBreak: 'break-word' }}>{listText(d.servers) || 'Not discovered yet'}</dd></div>
          <div><dt className="t-small text-muted">Base DN</dt><dd className="m-0" style={{ wordBreak: 'break-word' }}>{d.base_dn || 'Not discovered yet'}</dd></div>
          <div><dt className="t-small text-muted">Connection</dt><dd className="m-0" style={{ wordBreak: 'break-word' }}>{d.url || 'None'}</dd></div>
          <div><dt className="t-small text-muted">Discovered</dt><dd className="m-0">{d.at ? whenText(d.at) : 'Never'}</dd></div>
          <div><dt className="t-small text-muted">Last test</dt><dd className="m-0">{st.last_test_at ? <span className="inline-flex items-center gap-2"><StatusChip status={st.last_test_ok ? 'pass' : 'fail'}>{st.last_test_ok ? 'Passed' : 'Failed'}</StatusChip>{whenText(st.last_test_at)}</span> : 'Never'}</dd></div>
          <div><dt className="t-small text-muted">Last sync</dt><dd className="m-0">{st.last_sync_at ? whenText(st.last_sync_at) : (sync ? 'Just now' : 'Never')}</dd></div>
          <div><dt className="t-small text-muted">Domain users known</dt><dd className="m-0 num">{data.user_count === undefined ? '-' : data.user_count}</dd></div>
        </dl>
        {d.error && <p role="alert" className="m-0" style={{ marginTop: 12, color: 'var(--fail)' }}>Discovery error: {d.error}</p>}
        <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={syncNow} disabled={syncing || !base.enabled || dirty}>{syncing ? 'Syncing' : 'Sync now'}</Button>
          {!base.enabled && <span className="t-small text-muted">Turn on and save Active Directory to sync.</span>}
          {base.enabled && dirty && <span className="t-small text-muted">Save changes before syncing.</span>}
          {lastSync && (
            <span className="t-small" aria-live="polite">
              {lastSync.users} users checked, {lastSync.updated} updated, {lastSync.deactivated} deactivated{lastSync.errors && lastSync.errors.length ? ', ' + lastSync.errors.length + ' errors' : ''}.
            </span>
          )}
        </div>
        {lastSync && lastSync.errors && lastSync.errors.length > 0 && (
          <ul className="t-small m-0" style={{ marginTop: 8, paddingLeft: 18, color: 'var(--fail)' }}>{lastSync.errors.map((e, i) => <li key={i} style={{ wordBreak: 'break-word' }}>{String(e)}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}

export default function DirectorySection() {
  const q = useQuery('/access/directory', {}, { events: ACCESS_EVENTS });
  return (
    <DataState q={q} skeleton={<SkeletonCard height={320} />}>
      {(data) => <Form data={data} reload={q.reload} />}
    </DataState>
  );
}
