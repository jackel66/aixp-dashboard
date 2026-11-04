import React, { useState } from 'react';
import Card from '../charts/Card.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import Dialog from '../ui/Dialog.jsx';
import DataTable from '../ui/DataTable.jsx';
import Tooltip from '../ui/Tooltip.jsx';
import { useToast } from '../ui/Toast.jsx';
import { Field } from './shared.jsx';
import DirectoryPicker from './DirectoryPicker.jsx';
import { ACCESS_EVENTS, PASSWORD_RULE, passwordOk, whenText, isLocked } from './access.js';
import { useQuery, clearQueryCache } from '../../lib/query.js';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';

function RoleChecks({ roles, value, onChange }) {
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.concat(id));
  if (!roles.length) return <p className="t-small text-muted m-0">No roles loaded.</p>;
  return (
    <div className="flex flex-col gap-1">
      {roles.map((r) => (
        <label key={r.id} className="inline-flex items-center gap-2">
          <input type="checkbox" checked={value.includes(r.id)} onChange={() => toggle(r.id)} /> {r.name}
        </label>
      ))}
    </div>
  );
}

function useSubmit(onDone) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (call, okMessage) => {
    setBusy(true);
    try {
      await call();
      toast.success(okMessage);
      clearQueryCache();
      onDone();
    } catch (e) {
      toast.error(e.message || 'Request failed');
    } finally { setBusy(false); }
  };
  return { busy, run };
}

function AddLocalDialog({ roles, onClose }) {
  const [f, setF] = useState({ username: '', display_name: '', email: '', password: '', role_ids: [] });
  const { busy, run } = useSubmit(onClose);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const uname = f.username.trim().toLowerCase();
  const problem = !uname ? 'Enter a username.' : !passwordOk(f.password) ? 'The password must be 10 to 128 characters.' : !f.role_ids.length ? 'Choose at least one role, or the user cannot sign in.' : '';
  const submit = (ev) => {
    if (ev) ev.preventDefault();
    if (problem || busy) return;
    run(() => api.post('/access/users', { username: uname, display_name: f.display_name.trim(), email: f.email.trim(), password: f.password, role_ids: f.role_ids }), 'User added');
  };
  return (
    <Dialog open title="Add local user" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!!problem || busy}>{busy ? 'Adding' : 'Add user'}</Button></>}>
      <form onSubmit={submit}>
        <Field label="Username" htmlFor="au-name"><input id="au-name" className="input w-full" autoFocus spellCheck={false} autoCapitalize="none" value={f.username} onChange={(e) => set('username', e.target.value)} /></Field>
        <Field label="Name" htmlFor="au-dn"><input id="au-dn" className="input w-full" value={f.display_name} onChange={(e) => set('display_name', e.target.value)} /></Field>
        <Field label="Email" htmlFor="au-mail" hint="Optional. Used to match the person in the usage data."><input id="au-mail" className="input w-full" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Password" htmlFor="au-pw" hint={PASSWORD_RULE}><input id="au-pw" className="input w-full" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} /></Field>
        <Field label="Roles"><RoleChecks roles={roles} value={f.role_ids} onChange={(v) => set('role_ids', v)} /></Field>
        <button type="submit" className="sr-only" tabIndex={-1}>Add user</button>
      </form>
    </Dialog>
  );
}

function AddDomainDialog({ roles, onClose }) {
  const [pick, setPick] = useState(null);
  const [roleIds, setRoleIds] = useState([]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const created = await api.post('/access/users/ad', { dn: pick.dn });
      if (roleIds.length && created && created.id) await api.put('/access/users/' + created.id, { role_ids: roleIds });
      toast.success('Domain user added');
      clearQueryCache();
      onClose();
    } catch (e) { toast.error(e.message || 'Request failed'); } finally { setBusy(false); }
  };
  return (
    <Dialog open title="Add domain user" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!pick || busy}>{busy ? 'Adding' : 'Add user'}</Button></>}>
      <Field label="Find in Active Directory" htmlFor="ad-find" hint="Search by name, account name or email. The user can sign in with their domain password once a role reaches them.">
        {pick ? (
          <div className="flex items-center gap-2"><span style={{ fontWeight: 600 }}>{pick.display_name || pick.sam}</span><span className="t-small text-muted">{pick.upn}</span><Button size="sm" variant="ghost" onClick={() => setPick(null)}>Change</Button></div>
        ) : <DirectoryPicker id="ad-find" type="user" label="Find a domain user" placeholder="Start typing a name" onPick={setPick} />}
      </Field>
      <Field label="Roles" hint="Optional. Groups and organizational units can grant roles too (Roles section)."><RoleChecks roles={roles} value={roleIds} onChange={setRoleIds} /></Field>
    </Dialog>
  );
}

function EditDialog({ user, roles, onClose }) {
  const directIds = user.roles.filter((r) => r.via === 'direct').map((r) => r.id);
  const [f, setF] = useState({ display_name: user.display_name || '', email: user.email || '', active: !!user.active, role_ids: directIds });
  const { busy, run } = useSubmit(onClose);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const ad = user.source === 'ad';
  const inherited = user.roles.filter((r) => r.via !== 'direct');
  const submit = (ev) => {
    if (ev) ev.preventDefault();
    if (busy) return;
    const body = ad ? { active: f.active, role_ids: f.role_ids } : { display_name: f.display_name.trim(), email: f.email.trim(), active: f.active, role_ids: f.role_ids };
    run(() => api.put('/access/users/' + user.id, body), 'User saved');
  };
  return (
    <Dialog open title={'Edit ' + user.username} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={busy}>{busy ? 'Saving' : 'Save'}</Button></>}>
      <form onSubmit={submit}>
        {ad ? <p className="t-small text-muted" style={{ marginTop: 0 }}>This is a domain account. Name and email come from Active Directory.</p> : (
          <>
            <Field label="Name" htmlFor="eu-dn"><input id="eu-dn" className="input w-full" value={f.display_name} onChange={(e) => set('display_name', e.target.value)} /></Field>
            <Field label="Email" htmlFor="eu-mail"><input id="eu-mail" className="input w-full" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          </>
        )}
        <Field label="Status"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active (can sign in)</label></Field>
        <Field label="Direct roles" hint={inherited.length ? 'Also reached through: ' + inherited.map((r) => r.name + ' (' + r.via.replace(':', ' ') + ')').join(', ') + '. Change those under Roles.' : undefined}>
          <RoleChecks roles={roles} value={f.role_ids} onChange={(v) => set('role_ids', v)} />
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>Save</button>
      </form>
    </Dialog>
  );
}

function ResetDialog({ user, onClose }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const { busy, run } = useSubmit(onClose);
  const problem = !passwordOk(pw) ? 'The password must be 10 to 128 characters.' : pw !== again ? 'The two passwords do not match.' : '';
  const submit = (ev) => {
    if (ev) ev.preventDefault();
    if (problem || busy) return;
    run(() => api.put('/access/users/' + user.id + '/password', { password: pw }), 'Password reset');
  };
  return (
    <Dialog open title={'Reset password for ' + user.username} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!!problem || busy}>{busy ? 'Saving' : 'Reset password'}</Button></>}>
      <form onSubmit={submit}>
        <Field label="New password" htmlFor="rp-pw" hint={PASSWORD_RULE}><input id="rp-pw" className="input w-full" type="password" autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="New password again" htmlFor="rp-pw2"><input id="rp-pw2" className="input w-full" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <p className="t-small text-muted m-0">Signs the user out everywhere.</p>
        <button type="submit" className="sr-only" tabIndex={-1}>Reset password</button>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ user, onClose }) {
  const { busy, run } = useSubmit(onClose);
  return (
    <Dialog open title={'Delete ' + user.username} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => run(() => api.delete('/access/users/' + user.id), 'User deleted')}>{busy ? 'Deleting' : 'Delete user'}</Button></>}>
      <p className="m-0">This removes the account, its sessions and its direct role assignments. Sign-in activity stays in the log. This cannot be undone.</p>
    </Dialog>
  );
}

function StatusChips({ u }) {
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {u.active ? <Chip tone="ok">Active</Chip> : <Chip>Disabled</Chip>}
      {isLocked(u) && <Chip tone="warn">Locked</Chip>}
      {!!u.default_password && <Chip tone="warn">Default password</Chip>}
    </span>
  );
}

export default function UsersSection() {
  const toast = useToast();
  const { ad, user: me } = useAuth();
  const users = useQuery('/access/users', {}, { events: ACCESS_EVENTS });
  const roles = useQuery('/access/roles', {}, { events: ACCESS_EVENTS });
  const [dlg, setDlg] = useState(null);
  const rows = (users.data && users.data.rows) || [];
  const roleRows = (roles.data && roles.data.rows) || [];
  const close = () => setDlg(null);
  const adOff = !(ad && ad.enabled);

  const toggleActive = async (u) => {
    try {
      await api.put('/access/users/' + u.id, { active: !u.active });
      toast.success(u.active ? 'User disabled' : 'User enabled');
      clearQueryCache();
    } catch (e) { toast.error(e.message || 'Request failed'); }
  };

  const columns = [
    { key: 'username', label: 'User', render: (u) => <span className="flex flex-col"><span style={{ fontWeight: 600 }}>{u.username}</span>{u.display_name && <span className="t-small text-muted">{u.display_name}</span>}</span> },
    { key: 'source', label: 'Source', render: (u) => <Chip tone={u.source === 'ad' ? 'accent' : 'gray'}>{u.source === 'ad' ? 'Domain' : 'Local'}</Chip> },
    { key: 'roles', label: 'Roles', render: (u) => (u.roles.length ? (
      <span className="flex flex-col">{u.roles.map((r) => (
        <span key={r.id + ':' + r.via}>{r.name}{r.via !== 'direct' && <span className="t-small text-muted"> via {r.via.replace(':', ' ')}</span>}</span>
      ))}</span>
    ) : <span className="text-muted">None</span>) },
    { key: 'status', label: 'Status', render: (u) => <StatusChips u={u} /> },
    { key: 'last_login_at', label: 'Last sign-in', render: (u) => <span className="num" title={whenText(u.last_login_at)} style={{ whiteSpace: 'nowrap' }}>{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Never'}</span> },
    { key: 'actions', label: 'Actions', render: (u) => (
      <span className="inline-flex" style={{ whiteSpace: 'nowrap' }}>
        <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'edit', user: u })} aria-label={'Edit ' + u.username}>Edit</Button>
        {u.source === 'local' && <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'reset', user: u })} aria-label={'Reset password for ' + u.username} title="Reset password">Reset</Button>}
        <Button size="sm" variant="ghost" disabled={!!me && me.id === u.id && u.active} onClick={() => toggleActive(u)} aria-label={(u.active ? 'Disable ' : 'Enable ') + u.username}>{u.active ? 'Disable' : 'Enable'}</Button>
        <Button size="sm" variant="ghost" disabled={!!me && me.id === u.id} onClick={() => setDlg({ kind: 'delete', user: u })} aria-label={'Delete ' + u.username}>Delete</Button>
      </span>
    ) }
  ];

  const toolbar = (
    <>
      <Button onClick={() => setDlg({ kind: 'local' })}>Add local user</Button>
      {adOff ? (
        <Tooltip text="Turn on Active Directory first (Active Directory section)."><Button variant="secondary" disabled>Add domain user</Button></Tooltip>
      ) : <Button variant="secondary" onClick={() => setDlg({ kind: 'domain' })}>Add domain user</Button>}
    </>
  );

  return (
    <div className="stack-32">
      {rows.some((u) => u.default_password) && (
        <Card><div className="flex items-start gap-2" role="alert"><Chip tone="warn">Warning</Chip><span>The initial administrator password is still the default. Change it before anyone else uses this app.</span></div></Card>
      )}
      <Card title="Users" caption="Local accounts and domain accounts that can sign in. Roles reached through a group or organizational unit show where they came from.">
        <DataTable ariaLabel="Users" columns={columns} rows={rows} rowKey="id" loading={users.loading} error={users.error} onRetry={users.reload}
          toolbar={toolbar} showDensity={false} emptyTitle="No users" />
      </Card>
      {dlg && dlg.kind === 'local' && <AddLocalDialog roles={roleRows} onClose={close} />}
      {dlg && dlg.kind === 'domain' && <AddDomainDialog roles={roleRows} onClose={close} />}
      {dlg && dlg.kind === 'edit' && <EditDialog user={dlg.user} roles={roleRows} onClose={close} />}
      {dlg && dlg.kind === 'reset' && <ResetDialog user={dlg.user} onClose={close} />}
      {dlg && dlg.kind === 'delete' && <DeleteDialog user={dlg.user} onClose={close} />}
    </div>
  );
}
