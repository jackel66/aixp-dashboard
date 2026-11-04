import React, { useState } from 'react';
import Card from '../charts/Card.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import Dialog from '../ui/Dialog.jsx';
import DataTable from '../ui/DataTable.jsx';
import { useToast } from '../ui/Toast.jsx';
import { Field } from './shared.jsx';
import DirectoryPicker from './DirectoryPicker.jsx';
import { ACCESS_EVENTS } from './access.js';
import { useQuery, clearQueryCache } from '../../lib/query.js';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';

function RoleDialog({ role, perms, onClose }) {
  const toast = useToast();
  const readOnly = !!(role && role.system);
  const [f, setF] = useState({ name: role ? role.name : '', description: role ? role.description || '' : '', permissions: role ? role.permissions.slice() : [] });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const toggle = (k) => set('permissions', f.permissions.includes(k) ? f.permissions.filter((x) => x !== k) : f.permissions.concat(k));
  const name = f.name.trim();
  const problem = name.length < 2 || name.length > 60 ? 'The name must be 2 to 60 characters.' : !f.permissions.length ? 'Choose at least one permission.' : '';
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (readOnly || problem || busy) return;
    setBusy(true);
    try {
      const body = { name, description: f.description.trim(), permissions: f.permissions };
      if (role) await api.put('/access/roles/' + role.id, body); else await api.post('/access/roles', body);
      toast.success(role ? 'Role saved' : 'Role created');
      clearQueryCache();
      onClose();
    } catch (e) { toast.error(e.message || 'Request failed'); } finally { setBusy(false); }
  };
  return (
    <Dialog open width={560} title={role ? (readOnly ? role.name + ' (system role)' : 'Edit role') : 'New role'} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>{!readOnly && <Button onClick={submit} disabled={!!problem || busy}>{busy ? 'Saving' : 'Save role'}</Button>}</>}>
      <form onSubmit={submit}>
        {readOnly && <p className="t-small text-muted" style={{ marginTop: 0 }}>System roles are fixed. Create a new role to use a different set of permissions.</p>}
        <Field label="Name" htmlFor="rd-name"><input id="rd-name" className="input w-full" autoFocus={!readOnly} disabled={readOnly} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Description" htmlFor="rd-desc"><input id="rd-desc" className="input w-full" disabled={readOnly} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Permissions">
          <div className="flex flex-col gap-2">
            {perms.map((p) => (
              <label key={p.key} className="flex items-start gap-2">
                <input type="checkbox" style={{ marginTop: 3 }} disabled={readOnly} checked={f.permissions.includes(p.key)} onChange={() => toggle(p.key)} />
                <span><span style={{ fontWeight: 600 }}>{p.label}</span> <span className="t-small text-muted">({p.key})</span><br /><span className="t-small text-muted">{p.description}</span></span>
              </label>
            ))}
          </div>
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>Save role</button>
      </form>
    </Dialog>
  );
}

function DeleteRoleDialog({ role, onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.delete('/access/roles/' + role.id);
      toast.success('Role deleted');
      clearQueryCache();
      onClose(true);
    } catch (e) { toast.error(e.message || 'Request failed'); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={'Delete ' + role.name} onClose={() => onClose(false)}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={go}>{busy ? 'Deleting' : 'Delete role'}</Button></>}>
      <p className="m-0">This removes the role and every assignment of it. People who only had this role lose access. This cannot be undone.</p>
    </Dialog>
  );
}

function AssignList({ title, empty, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <h3 className="t-h3 m-0" style={{ marginBottom: 8 }}>{title}</h3>
      {children}
      {empty && <p className="t-small text-muted m-0">{empty}</p>}
    </div>
  );
}

function AssignmentsPanel({ role }) {
  const toast = useToast();
  const { ad } = useAuth();
  const q = useQuery('/access/roles/' + role.id + '/assignments', {}, { events: ACCESS_EVENTS });
  const users = useQuery('/access/users', {}, { events: ACCESS_EVENTS });
  const [userId, setUserId] = useState('');
  const rows = (q.data && q.data.rows) || [];
  const byType = (t) => rows.filter((r) => r.subject_type === t);
  const adOff = !(ad && ad.enabled);
  const reason = adOff ? 'Active Directory is off. Turn it on in the Active Directory section to assign groups and organizational units.' : '';

  const act = async (call, ok) => {
    try { await call(); toast.success(ok); clearQueryCache(); } catch (e) { toast.error(e.message || 'Request failed'); }
  };
  const remove = (a) => act(() => api.delete('/access/roles/' + role.id + '/assignments/' + a.id), 'Assignment removed');
  const assignedUsers = byType('user').map((a) => a.user && a.user.id);
  const pickable = ((users.data && users.data.rows) || []).filter((u) => !assignedUsers.includes(u.id));

  const row = (a, label, sub) => (
    <li key={a.id} className="flex items-center gap-2 justify-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{label}{sub && <span className="t-small text-muted"> {sub}</span>}</span>
      <Button size="sm" variant="ghost" onClick={() => remove(a)} aria-label={'Remove ' + label}>Remove</Button>
    </li>
  );

  return (
    <Card title={'Assignments for ' + role.name} caption="Everyone reached by an assignment gets this role. A person's permissions are the union of every role that reaches them.">
      <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <AssignList title="Users" empty={byType('user').length ? '' : 'No users assigned directly.'}>
          <ul className="list-none p-0 m-0" style={{ borderTop: byType('user').length ? '1px solid var(--line)' : 'none' }}>
            {byType('user').map((a) => row(a, a.user ? a.user.display_name || a.user.username : 'Removed user', a.user ? '(' + a.user.username + ', ' + (a.user.source === 'ad' ? 'domain' : 'local') + ')' : ''))}
          </ul>
          <div className="flex gap-2" style={{ marginTop: 8 }}>
            <select className="input" aria-label="Add a user to this role" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
              <option value="">Choose a user</option>
              {pickable.map((u) => <option key={u.id} value={u.id}>{(u.display_name || u.username) + ' (' + u.username + ')'}</option>)}
            </select>
            <Button variant="secondary" disabled={!userId} onClick={() => act(() => api.post('/access/roles/' + role.id + '/assignments', { subject_type: 'user', user_id: Number(userId) }).then(() => setUserId('')), 'User added to role')}>Add</Button>
          </div>
        </AssignList>
        <AssignList title="AD groups" empty={byType('ad_group').length ? '' : 'No groups assigned.'}>
          <ul className="list-none p-0 m-0" style={{ borderTop: byType('ad_group').length ? '1px solid var(--line)' : 'none' }}>
            {byType('ad_group').map((a) => row(a, a.ad_name || a.ad_dn, ''))}
          </ul>
          <div style={{ marginTop: 8 }}>
            <DirectoryPicker type="group" label="Add an AD group to this role" placeholder="Search groups" disabledReason={reason} exclude={byType('ad_group').map((a) => a.ad_dn)}
              onPick={(g) => act(() => api.post('/access/roles/' + role.id + '/assignments', { subject_type: 'ad_group', ad_dn: g.dn, ad_sid: g.sid, ad_name: g.name }), 'Group added to role')} />
          </div>
        </AssignList>
        <AssignList title="AD organizational units" empty={byType('ad_ou').length ? '' : 'No organizational units assigned.'}>
          <ul className="list-none p-0 m-0" style={{ borderTop: byType('ad_ou').length ? '1px solid var(--line)' : 'none' }}>
            {byType('ad_ou').map((a) => row(a, a.ad_name || a.ad_dn, a.ad_name ? '(' + a.ad_dn + ')' : ''))}
          </ul>
          <div style={{ marginTop: 8 }}>
            <DirectoryPicker type="ou" label="Add an AD organizational unit to this role" placeholder="Search organizational units" disabledReason={reason} exclude={byType('ad_ou').map((a) => a.ad_dn)}
              onPick={(o) => act(() => api.post('/access/roles/' + role.id + '/assignments', { subject_type: 'ad_ou', ad_dn: o.dn, ad_name: o.name }), 'Organizational unit added to role')} />
          </div>
        </AssignList>
      </div>
    </Card>
  );
}

export default function RolesSection() {
  const roles = useQuery('/access/roles', {}, { events: ACCESS_EVENTS });
  const perms = useQuery('/access/permissions', {}, { events: ACCESS_EVENTS });
  const [dlg, setDlg] = useState(null);
  const [selId, setSelId] = useState(null);
  const rows = (roles.data && roles.data.rows) || [];
  const permList = Array.isArray(perms.data) ? perms.data : ((perms.data && perms.data.rows) || []);
  const label = (k) => (permList.find((p) => p.key === k) || { label: k }).label;
  const selected = rows.find((r) => r.id === selId) || null;

  const columns = [
    { key: 'name', label: 'Role', render: (r) => (
      <span className="inline-flex items-center gap-2 flex-wrap"><span style={{ fontWeight: 600 }}>{r.name}</span>{!!r.system && <Chip tone="outline">System</Chip>}</span>
    ) },
    { key: 'description', label: 'Description', render: (r) => <span className="text-muted">{r.description || '-'}</span> },
    { key: 'permissions', label: 'Permissions', render: (r) => (
      <span className="inline-flex gap-1 flex-wrap">{r.permissions.map((k) => <Chip key={k}>{label(k)}</Chip>)}</span>
    ) },
    { key: 'counts', label: 'Reached by', render: (r) => <span className="t-small num">{r.user_count} users, {r.group_count} groups, {r.ou_count} OUs</span> },
    { key: 'actions', label: 'Actions', render: (r) => (
      <span className="inline-flex gap-1 flex-wrap">
        <Button size="sm" variant={selId === r.id ? 'secondary' : 'ghost'} aria-pressed={selId === r.id} onClick={() => setSelId(selId === r.id ? null : r.id)} aria-label={'Assignments for ' + r.name}>Assignments</Button>
        <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'edit', role: r })} aria-label={(r.system ? 'View ' : 'Edit ') + r.name}>{r.system ? 'View' : 'Edit'}</Button>
        {!r.system && <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'delete', role: r })} aria-label={'Delete ' + r.name}>Delete</Button>}
      </span>
    ) }
  ];

  return (
    <div className="stack-32">
      <Card title="Roles" caption="A role is a named set of permissions. Assign it to users, AD groups or AD organizational units.">
        <DataTable ariaLabel="Roles" columns={columns} rows={rows} rowKey="id" loading={roles.loading} error={roles.error} onRetry={roles.reload}
          toolbar={<Button onClick={() => setDlg({ kind: 'new' })}>New role</Button>} showDensity={false} emptyTitle="No roles" />
      </Card>
      {selected && <AssignmentsPanel role={selected} />}
      {dlg && dlg.kind === 'new' && <RoleDialog perms={permList} onClose={() => setDlg(null)} />}
      {dlg && dlg.kind === 'edit' && <RoleDialog role={dlg.role} perms={permList} onClose={() => setDlg(null)} />}
      {dlg && dlg.kind === 'delete' && <DeleteRoleDialog role={dlg.role} onClose={(gone) => { if (gone && selId === dlg.role.id) setSelId(null); setDlg(null); }} />}
    </div>
  );
}
