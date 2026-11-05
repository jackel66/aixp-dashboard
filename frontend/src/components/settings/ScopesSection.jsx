import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Card from '../charts/Card.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import Dialog from '../ui/Dialog.jsx';
import DataTable from '../ui/DataTable.jsx';
import Tooltip from '../ui/Tooltip.jsx';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import { useToast } from '../ui/Toast.jsx';
import { Field } from './shared.jsx';
import DirectoryPicker from './DirectoryPicker.jsx';
import { ACCESS_EVENTS } from './access.js';
import { useQuery, clearQueryCache } from '../../lib/query.js';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';

const UNASSIGNED_HINT = 'People whose line of business is blank, unassigned or unknown in the usage data.';
const TYPE_LABEL = { user: 'User', ad_group: 'AD group', ad_ou: 'AD OU' };

// A list of scope-value checkboxes, with a search box above 12 values and Unassigned last.
export function ScopeValueChecks({ values, value, onChange, idPrefix = 'sv' }) {
  const [text, setText] = useState('');
  const ordered = useMemo(() => {
    const real = values.filter((v) => v.value !== 'Unassigned');
    const un = values.filter((v) => v.value === 'Unassigned');
    return real.concat(un);
  }, [values]);
  if (!ordered.length) return <p className="t-small text-muted m-0">No lines of business loaded.</p>;
  const needle = text.trim().toLowerCase();
  const shown = needle ? ordered.filter((v) => v.value.toLowerCase().includes(needle)) : ordered;
  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : value.concat(v));
  return (
    <div>
      {ordered.length > 12 && (
        <input className="input w-full" type="search" aria-label="Search lines of business" placeholder="Search lines of business" value={text}
          onChange={(e) => setText(e.target.value)} style={{ marginBottom: 8 }} />
      )}
      <div className="flex flex-col gap-1" style={{ maxHeight: 240, overflow: 'auto' }}>
        {shown.map((v, i) => (
          <label key={v.value} className="inline-flex items-start gap-2" htmlFor={idPrefix + '-' + i}>
            <input id={idPrefix + '-' + i} type="checkbox" style={{ marginTop: 3 }} checked={value.includes(v.value)} onChange={() => toggle(v.value)} />
            <span>
              {v.value}
              {typeof v.people === 'number' && <span className="t-small text-muted"> ({v.people} people)</span>}
              {v.value === 'Unassigned' && <span className="t-small text-muted"> {UNASSIGNED_HINT}</span>}
              {v.in_active_dataset === false && <span className="t-small text-muted"> not in current data</span>}
            </span>
          </label>
        ))}
        {!shown.length && <p className="t-small text-muted m-0">No matches.</p>}
      </div>
    </div>
  );
}

function GrantDialog({ onClose }) {
  const toast = useToast();
  const { ad } = useAuth();
  const adOff = !(ad && ad.enabled);
  const reason = adOff ? 'Active Directory is off. Turn it on in the Active Directory section.' : '';
  const users = useQuery('/access/users', {}, { events: ACCESS_EVENTS });
  const vals = useQuery('/access/scope-values', {}, { events: ACCESS_EVENTS });
  const [kind, setKind] = useState('user');
  const [userId, setUserId] = useState('');
  const [pick, setPick] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const userRows = (users.data && users.data.rows) || [];
  const valueRows = (vals.data && vals.data.values) || [];
  const subjectOk = kind === 'user' ? !!userId : !!pick;
  const problem = !subjectOk ? (kind === 'user' ? 'Choose a user.' : 'Choose a ' + (kind === 'ad_group' ? 'group' : 'organizational unit') + '.') : !chosen.length ? 'Choose at least one line of business.' : '';

  const changeKind = (k) => { setKind(k); setPick(null); setUserId(''); };
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    try {
      const body = kind === 'user' ? { subject_type: 'user', user_id: Number(userId) }
        : kind === 'ad_group' ? { subject_type: 'ad_group', ad_dn: pick.dn, ad_sid: pick.sid, ad_name: pick.name }
          : { subject_type: 'ad_ou', ad_dn: pick.dn, ad_name: pick.name };
      await api.post('/access/scopes', { ...body, dim: 'lob_cg', values: chosen });
      toast.success('Scope granted');
      clearQueryCache();
      onClose();
    } catch (e) { toast.error(e.message || 'Request failed'); } finally { setBusy(false); }
  };

  return (
    <Dialog open width={560} title="Grant scope" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!!problem || busy}>{busy ? 'Saving' : 'Grant scope'}</Button></>}>
      <form onSubmit={submit}>
        <Field label="Grant to">
          <SegmentedControl label="Grant to" value={kind} onChange={changeKind}
            options={[{ value: 'user', label: 'Local user' }, { value: 'ad_group', label: 'AD group' }, { value: 'ad_ou', label: 'AD OU' }]} />
          {adOff && <p className="t-small text-muted m-0" style={{ marginTop: 4 }}>{reason} AD group and AD OU grants stay unavailable until then.</p>}
        </Field>
        {kind === 'user' ? (
          <Field label="User" htmlFor="gs-user" hint="Local and domain accounts are listed.">
            <select id="gs-user" className="input w-full" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a user</option>
              {userRows.map((u) => <option key={u.id} value={u.id}>{(u.display_name || u.username) + ' (' + u.username + ', ' + (u.source === 'ad' ? 'domain' : 'local') + ')'}</option>)}
            </select>
          </Field>
        ) : (
          <Field label={kind === 'ad_group' ? 'AD group' : 'AD organizational unit'} htmlFor="gs-dir">
            {pick ? (
              <div className="flex items-center gap-2"><span style={{ fontWeight: 600 }}>{pick.name}</span><Button size="sm" variant="ghost" onClick={() => setPick(null)}>Change</Button></div>
            ) : (
              <DirectoryPicker id="gs-dir" type={kind === 'ad_group' ? 'group' : 'ou'} label={kind === 'ad_group' ? 'Find an AD group' : 'Find an AD organizational unit'}
                placeholder={kind === 'ad_group' ? 'Search groups' : 'Search organizational units'} disabledReason={reason} onPick={setPick} />
            )}
          </Field>
        )}
        <Field label="Lines of business" hint="The user sees only these lines and the people in them.">
          <ScopeValueChecks values={valueRows} value={chosen} onChange={setChosen} idPrefix="gs" />
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>Grant scope</button>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ grant, name, onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.delete('/access/scopes/' + grant.id);
      toast.success('Scope removed');
      clearQueryCache();
      onClose();
    } catch (e) { toast.error(e.message || 'Request failed'); } finally { setBusy(false); }
  };
  return (
    <Dialog open title="Remove scope" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} onClick={go}>{busy ? 'Removing' : 'Remove scope'}</Button></>}>
      <p className="m-0">Remove {grant.value} from {name}? They stop seeing that line of business as soon as their session next refreshes.</p>
    </Dialog>
  );
}

function subjectName(r) {
  if (r.subject_type === 'user') return r.user ? (r.user.display_name || r.user.username) : 'Removed user';
  return r.ad_name || r.ad_dn;
}

function EveryonePanel() {
  const roles = useQuery('/access/roles', {}, { events: ACCESS_EVENTS });
  const rows = ((roles.data && roles.data.rows) || []).filter((r) => (r.permissions || []).includes('data.all'));
  return (
    <Card title="Who sees everything" caption="Roles that carry the data.all permission. Anyone reached by one of them sees every line of business, including Unmatched and Unassigned.">
      {roles.loading ? <p className="t-small text-muted m-0">Loading.</p> : !rows.length ? <p className="t-small text-muted m-0">No role carries data.all.</p> : (
        <ul className="list-none p-0 m-0" style={{ borderTop: '1px solid var(--line)' }}>
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 justify-between flex-wrap" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="inline-flex items-center gap-2"><span style={{ fontWeight: 600 }}>{r.name}</span>{!!r.system && <Chip tone="outline">System</Chip>}</span>
              <span className="t-small num text-muted">{r.user_count} users, {r.group_count} groups, {r.ou_count} OUs</span>
            </li>
          ))}
        </ul>
      )}
      <p className="t-small m-0" style={{ marginTop: 12 }}><Link to="/settings/roles">Manage roles</Link></p>
    </Card>
  );
}

export default function ScopesSection() {
  const scopes = useQuery('/access/scopes', {}, { events: ACCESS_EVENTS });
  const [dlg, setDlg] = useState(null);
  const rows = (scopes.data && scopes.data.rows) || [];

  const groups = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      const key = r.subject_type === 'user' ? 'user:' + (r.user ? r.user.id : r.id) : r.subject_type + ':' + r.ad_dn;
      if (!m.has(key)) m.set(key, { key, type: r.subject_type, name: subjectName(r), user: r.user, grants: [] });
      m.get(key).grants.push(r);
    });
    const order = { user: 0, ad_group: 1, ad_ou: 2 };
    return Array.from(m.values()).sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
  }, [rows]);

  const columns = [
    { key: 'name', label: 'Who', render: (g) => (
      <span className="flex flex-col"><span style={{ fontWeight: 600 }}>{g.name}</span>
        {g.user && g.user.display_name && <span className="t-small text-muted">{g.user.username}</span>}
      </span>
    ) },
    { key: 'type', label: 'Kind', render: (g) => (
      <Chip tone={g.type === 'user' && !(g.user && g.user.source === 'ad') ? 'gray' : 'accent'}>{g.type === 'user' ? (g.user && g.user.source === 'ad' ? 'Domain user' : 'Local user') : TYPE_LABEL[g.type]}</Chip>
    ) },
    { key: 'grants', label: 'Lines of business', render: (g) => (
      <span className="inline-flex gap-1 flex-wrap">
        {g.grants.map((r) => {
          const gone = r.in_active_dataset === false;
          const chip = (
            <span className={'chip ' + (gone ? 'chip-outline' : 'chip-accent')} style={gone ? { opacity: 0.7, borderStyle: 'dashed' } : undefined}>
              {r.value}
              <button type="button" className="bg-transparent border-0 cursor-pointer text-ink" style={{ font: 'inherit', padding: '0 0 0 6px' }}
                aria-label={'Remove ' + r.value + ' from ' + g.name} onClick={() => setDlg({ grant: r, name: g.name })}>x</button>
            </span>
          );
          return gone ? <Tooltip key={r.id} text="Not in current data: this value no longer appears in the active dataset."><span>{chip}</span></Tooltip> : <span key={r.id}>{chip}</span>;
        })}
      </span>
    ) }
  ];

  return (
    <div className="stack-32">
      <Card title="Data scopes" caption="A user without the data.all permission sees only the lines of business granted here. Grants reach a user directly, through an AD group, or through an AD organizational unit. The Executive and Analyst roles include data.all.">
        <DataTable ariaLabel="Data scopes" columns={columns} rows={groups} rowKey="key" loading={scopes.loading} error={scopes.error} onRetry={scopes.reload}
          toolbar={<Button onClick={() => setDlg({ grant: null })}>Grant scope</Button>} showDensity={false}
          emptyTitle="No scopes granted" emptyBody="Users without data.all see nothing until a line of business is granted." />
      </Card>
      <EveryonePanel />
      {dlg && !dlg.grant && <GrantDialog onClose={() => setDlg(null)} />}
      {dlg && dlg.grant && <RemoveDialog grant={dlg.grant} name={dlg.name} onClose={() => setDlg(null)} />}
    </div>
  );
}
