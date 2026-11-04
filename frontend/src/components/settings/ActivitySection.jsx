import React, { useState } from 'react';
import Card from '../charts/Card.jsx';
import Chip from '../ui/Chip.jsx';
import DataTable from '../ui/DataTable.jsx';
import { ACCESS_EVENTS, whenText } from './access.js';
import { useQuery } from '../../lib/query.js';
import { useLiveRefresh } from '../../lib/live.jsx';

const KINDS = [
  ['login_ok', 'Sign-in succeeded'], ['login_fail', 'Sign-in failed'], ['login_locked', 'Sign-in locked'], ['logout', 'Sign-out'],
  ['password_change', 'Password changed'], ['password_reset', 'Password reset'],
  ['user_created', 'User created'], ['user_updated', 'User updated'], ['user_deleted', 'User deleted'],
  ['role_created', 'Role created'], ['role_updated', 'Role updated'], ['role_deleted', 'Role deleted'],
  ['assignment_added', 'Assignment added'], ['assignment_removed', 'Assignment removed'],
  ['ad_test', 'Directory test'], ['ad_sync', 'Directory sync'], ['ad_config', 'Directory settings']
];
const KIND_LABEL = Object.fromEntries(KINDS);
const TONE = { login_ok: 'ok', login_fail: 'warn', login_locked: 'fail' };

export default function ActivitySection() {
  const [kind, setKind] = useState('');
  const q = useQuery('/access/events', { limit: 200, kind }, { events: ACCESS_EVENTS });
  useLiveRefresh(['access.changed'], () => q.reload());
  const rows = (q.data && q.data.rows) || [];
  const columns = [
    { key: 'at', label: 'When', render: (r) => <span className="num" style={{ whiteSpace: 'nowrap' }}>{whenText(r.at)}</span> },
    { key: 'kind', label: 'Event', render: (r) => <Chip tone={TONE[r.kind] || 'gray'}>{KIND_LABEL[r.kind] || r.kind}</Chip> },
    { key: 'username', label: 'Username', render: (r) => r.username || '-' },
    { key: 'source', label: 'Source', render: (r) => (r.source ? (r.source === 'ad' ? 'Domain' : 'Local') : '-') },
    { key: 'ip', label: 'IP address', render: (r) => <span className="num">{r.ip || '-'}</span> },
    { key: 'detail', label: 'Detail', render: (r) => <span className="text-muted" style={{ wordBreak: 'break-word' }}>{r.detail || '-'}</span> }
  ];
  const toolbar = (
    <label className="inline-flex items-center gap-2 t-small text-muted">Event
      <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by event kind">
        <option value="">All events</option>
        {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
  return (
    <Card title="Sign-in activity" caption="The newest 200 events, newest first. Passwords and secrets are never recorded. Entries are kept for 180 days.">
      <DataTable ariaLabel="Sign-in activity" columns={columns} rows={rows} rowKey="id" loading={q.loading} error={q.error} onRetry={q.reload}
        toolbar={toolbar} showDensity={false} emptyTitle="No events" emptyBody={kind ? 'No events of this kind yet.' : 'Nothing has been recorded yet.'} />
    </Card>
  );
}
