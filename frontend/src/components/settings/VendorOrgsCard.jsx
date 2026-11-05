import React, { useMemo, useState } from 'react';
import DataState from '../DataState.jsx';
import Button from '../ui/Button.jsx';
import Chip from '../ui/Chip.jsx';
import DataTable from '../ui/DataTable.jsx';
import Drawer from '../ui/Drawer.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { useToast } from '../ui/Toast.jsx';
import Card from '../charts/Card.jsx';
import { useQuery, clearQueryCache } from '../../lib/query.js';
import { api } from '../../lib/api.js';
import { count, dateShort } from '../../lib/format.js';

const METHODS = {
  exact: 'Exact',
  normalized: 'Normalized',
  alias: 'Alias',
  fuzzy_confirmed: 'Confirmed',
  manual: 'Manual'
};

function PeopleBody({ row }) {
  const q = useQuery('/vendor-orgs/' + row.id + '/people', {});
  return (
    <DataState q={q} skeleton={<SkeletonCard height={160} />}>
      {(d) => (
        <div>
          <p className="t-small text-muted m-0" style={{ marginBottom: 12 }}>
            {row.lob_cg ? 'Mapped to ' + row.lob_cg + '.' : 'Not mapped to a LOB-CG yet.'} People who are in the extract keep the LOB-CG the extract gives them.
          </p>
          <table className="tbl compact" aria-label="People in this vendor org">
            <thead><tr><th>Person</th><th>Email</th><th>Extract</th></tr></thead>
            <tbody>
              {(d.rows || []).map((p) => (
                <tr key={p.person_key}>
                  <td>{p.display_name || p.person_key}</td>
                  <td>{p.email || 'n/a'}</td>
                  <td>
                    {p.in_extract ? <Chip tone="ok">in extract</Chip> : <Chip tone="outline">not in extract</Chip>}
                    {p.in_extract && p.extract_lob_cg && row.lob_cg && p.extract_lob_cg !== row.lob_cg && <Chip tone="warn" className="ml-1">extract: {p.extract_lob_cg}</Chip>}
                  </td>
                </tr>
              ))}
              {!(d.rows || []).length && <tr><td colSpan={3} className="text-muted">No people recorded for this value.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </DataState>
  );
}

function Aliases({ data, toast }) {
  const [alias, setAlias] = useState('');
  const [lob, setLob] = useState('');
  const [busy, setBusy] = useState(false);
  const lobs = data.lob_values || [];
  const add = async () => {
    setBusy(true);
    try {
      await api.post('/vendor-orgs/aliases', { alias: alias.trim(), lob_cg: lob });
      toast.success('Alias added');
      setAlias(''); setLob('');
      clearQueryCache();
    } catch (e) { toast.error(e.status === 409 ? 'That alias already exists' : (e.message || 'Could not add the alias')); } finally { setBusy(false); }
  };
  const remove = async (a) => {
    try { await api.delete('/vendor-orgs/aliases/' + a.id); toast.success('Alias removed'); clearQueryCache(); } catch (e) { toast.error(e.message || 'Could not remove the alias'); }
  };
  return (
    <details style={{ marginTop: 16 }}>
      <summary className="t-small" style={{ cursor: 'pointer', fontWeight: 600 }}>Aliases ({(data.aliases || []).length})</summary>
      <p className="t-small text-muted m-0" style={{ margin: '8px 0' }}>An alias maps a spelling to a LOB-CG for every vendor, after the exact and normalized checks.</p>
      {(data.aliases || []).length > 0 && (
        <ul className="list-none p-0 m-0" aria-label="Aliases" style={{ borderTop: '1px solid var(--line)' }}>
          {data.aliases.map((a) => (
            <li key={a.id} className="flex items-center gap-3 flex-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="num" style={{ minWidth: 180 }}>{a.alias}</span>
              <span className="text-muted">maps to</span>
              <span style={{ flex: 1, fontWeight: 600 }}>{a.lob_cg}</span>
              <Button variant="ghost" size="sm" aria-label={'Remove alias ' + a.alias} onClick={() => remove(a)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 flex-wrap items-center" style={{ marginTop: 12 }}>
        <input className="input" aria-label="Alias text" placeholder="Alias text" value={alias} onChange={(e) => setAlias(e.target.value)} style={{ minWidth: 200 }} />
        <select className="input" aria-label="Alias LOB-CG" value={lob} onChange={(e) => setLob(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">Choose a LOB-CG</option>
          {lobs.map((l) => <option key={l.value} value={l.value}>{l.value}</option>)}
        </select>
        <Button variant="secondary" size="sm" onClick={add} disabled={busy || !alias.trim() || !lob}>Add alias</Button>
      </div>
    </details>
  );
}

function Body({ data }) {
  const toast = useToast();
  const [vendor, setVendor] = useState('');
  const [draft, setDraft] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [applying, setApplying] = useState(false);
  const [people, setPeople] = useState(null);
  const vendors = useMemo(() => Array.from(new Set((data.rows || []).map((r) => r.vendor))).sort(), [data]);
  const rows = (data.rows || []).filter((r) => !vendor || r.vendor === vendor);
  const lobs = data.lob_values || [];
  const counts = data.counts || {};

  const current = (r) => (draft[r.id] !== undefined ? draft[r.id] : (r.lob_cg || ''));
  const setRow = (r, v) => setDraft((d) => ({ ...d, [r.id]: v }));
  const clearDraft = (id) => setDraft((d) => { const n = { ...d }; delete n[id]; return n; });

  const saveRow = async (r) => {
    const v = current(r);
    if (!v) return;
    const fromSuggestion = (r.suggestions || []).some((x) => x.lob_cg === v);
    setBusyId(r.id);
    try {
      await api.put('/vendor-orgs/' + r.id, { lob_cg: v, method: fromSuggestion ? 'fuzzy_confirmed' : 'manual' });
      toast.success('Mapping saved');
      clearDraft(r.id);
      clearQueryCache();
    } catch (e) { toast.error(e.message || 'Could not save the mapping'); } finally { setBusyId(null); }
  };
  const clearRow = async (r) => {
    setBusyId(r.id);
    try {
      await api.put('/vendor-orgs/' + r.id, { lob_cg: null });
      toast.success('Mapping cleared');
      clearDraft(r.id);
      clearQueryCache();
    } catch (e) { toast.error(e.message || 'Could not clear the mapping'); } finally { setBusyId(null); }
  };
  const apply = async () => {
    setApplying(true);
    try {
      const r = await api.post('/vendor-orgs/apply', {});
      toast.success('Mappings applied: ' + count(r.mapped || 0) + ' mapped, ' + count(r.unmatched || 0) + ' unmatched, ' + count(r.people_unmatched || 0) + ' people still without a LOB');
      clearQueryCache();
    } catch (e) { toast.error(e.message || 'Could not apply the mappings'); } finally { setApplying(false); }
  };

  const columns = [
    { key: 'vendor', label: 'Vendor', render: (r) => r.vendor },
    { key: 'value', label: 'Vendor org', render: (r) => <span title={r.normalized}>{r.value}</span> },
    { key: 'people', label: 'People', align: 'r', render: (r) => (
      <Button variant="ghost" size="sm" aria-label={'Show ' + r.people_count + ' people in ' + r.value} onClick={() => setPeople(r)}>{count(r.people_count)}</Button>
    ) },
    { key: 'map', label: 'Maps to', render: (r) => {
      const v = current(r);
      const opts = lobs.some((l) => l.value === v) || !v ? lobs : lobs.concat({ value: v, sort: 999 });
      return (
        <div>
          <select className="input" aria-label={'LOB-CG for ' + r.value} value={v} onChange={(e) => setRow(r, e.target.value)} style={{ minWidth: 190 }}>
            <option value="">Not mapped</option>
            {opts.map((l) => <option key={l.value} value={l.value}>{l.value}</option>)}
          </select>
          {(r.suggestions || []).length > 0 && (
            <div className="flex gap-1 flex-wrap" style={{ marginTop: 4 }} aria-label="Suggestions">
              {r.suggestions.map((x) => (
                <button key={x.lob_cg} type="button" className="chip chip-accent cursor-pointer border-0" style={{ font: 'inherit' }} aria-label={'Use suggestion ' + x.lob_cg + ', score ' + x.score.toFixed(2)} onClick={() => setRow(r, x.lob_cg)}>
                  {x.lob_cg} <span className="num">{x.score.toFixed(2)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    } },
    { key: 'method', label: 'Method', render: (r) => (r.match_method ? <Chip tone={r.match_method === 'exact' || r.match_method === 'normalized' ? 'ok' : 'gray'}>{METHODS[r.match_method] || r.match_method}</Chip> : <Chip tone="warn">Unmatched</Chip>) },
    { key: 'by', label: 'Confirmed by', render: (r) => (r.confirmed_by ? r.confirmed_by.username : <span className="text-muted">n/a</span>) },
    { key: 'seen', label: 'Last seen', render: (r) => (r.last_seen_at ? dateShort(String(r.last_seen_at).slice(0, 10)) : 'n/a') },
    { key: 'act', label: 'Actions', render: (r) => {
      const changed = current(r) !== (r.lob_cg || '');
      return (
        <div className="flex flex-col gap-1">
          <Button size="sm" onClick={() => saveRow(r)} disabled={!changed || !current(r) || busyId === r.id} aria-label={'Save mapping for ' + r.value}>Save</Button>
          <Button variant="ghost" size="sm" onClick={() => clearRow(r)} disabled={!r.lob_cg || busyId === r.id} aria-label={'Clear mapping for ' + r.value}>Clear</Button>
        </div>
      );
    } }
  ];

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Vendor filter" style={{ marginBottom: 8 }}>
        <button type="button" className={'chip cursor-pointer ' + (!vendor ? 'chip-accent' : 'chip-outline')} style={{ font: 'inherit' }} aria-pressed={!vendor} onClick={() => setVendor('')}>All vendors</button>
        {vendors.map((v) => (
          <button key={v} type="button" className={'chip cursor-pointer ' + (vendor === v ? 'chip-accent' : 'chip-outline')} style={{ font: 'inherit' }} aria-pressed={vendor === v} onClick={() => setVendor(v)}>{v}</button>
        ))}
      </div>
      <p className="t-small m-0" style={{ marginBottom: 8 }} aria-live="polite">
        <span className="num">{count(counts.mapped || 0)}</span> mapped, <span className="num">{count(counts.unmatched || 0)}</span> unmatched. A mapping would give <span className="num">{count(counts.people_unmatched || 0)}</span> people without a LOB one.
      </p>
      <DataTable ariaLabel="Vendor orgs" columns={columns} rows={rows} rowKey="id" showDensity={false} maxHeight={520}
        emptyTitle="No vendor orgs yet" emptyBody="They appear after a connector pull that returns team or group data." />
      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 12 }}>
        <Button variant="secondary" onClick={apply} disabled={applying}>{applying ? 'Applying' : 'Apply mappings now'}</Button>
        <a href="/api/vendor-orgs/export.csv" className="t-small" download>Export CSV</a>
      </div>
      <Aliases data={data} toast={toast} />
      <Drawer open={!!people} onClose={() => setPeople(null)} title={people ? people.value + ' (' + people.vendor + ')' : ''}>
        {people && <PeopleBody row={people} />}
      </Drawer>
    </>
  );
}

export default function VendorOrgsCard() {
  const q = useQuery('/vendor-orgs', {}, { events: ['settings.changed', 'dataset.*', 'import.*'] });
  return (
    <Card id="vendor-orgs" title="Vendor orgs" caption="Teams and groups that vendors report, mapped to a LOB-CG. Suggestions are never applied until you save them. A person in the extract always keeps the extract's LOB-CG.">
      <DataState q={q} skeleton={<SkeletonCard height={260} />}>{(d) => <Body data={d} />}</DataState>
    </Card>
  );
}
