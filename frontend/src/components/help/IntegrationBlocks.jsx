import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../../lib/query.js';
import { Chip } from '../ui/Chip.jsx';
import Button from '../ui/Button.jsx';
import DataState from '../DataState.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';

// Plain ASCII rendering of one entry, for a firewall or access request email.
export function entryToText(e) {
  const out = [];
  out.push(e.name + ' (' + e.kind + ')');
  out.push(e.summary);
  const list = (title, items) => { if (items && items.length) { out.push('', title + ':'); items.forEach((x) => out.push('- ' + x)); } };
  if (e.urls && e.urls.length) { out.push('', 'Addresses:'); e.urls.forEach((u) => out.push('- ' + u.label + ': ' + u.value)); }
  if (e.ports) out.push('', 'Network:', e.ports);
  list('Credentials', e.credentials);
  list('Permissions', e.permissions);
  list('Limits', e.limits);
  if (e.where) out.push('', 'Where in the app:', e.where);
  list('Notes', e.notes);
  return out.join('\n').replace(/[^\x20-\x7E\n]/g, '?');
}

const LBL = { fontWeight: 600, margin: '14px 0 4px' };

function Block({ title, children }) {
  return (<section><h3 className="t-small" style={LBL}>{title}</h3>{children}</section>);
}

function Items({ items }) {
  return (<ul className="m-0" style={{ paddingLeft: 18, listStyle: 'disc' }}>{items.map((x, i) => <li key={i} className="t-small" style={{ marginBottom: 4 }}>{x}</li>)}</ul>);
}

// The labelled blocks of one entry. Used by the Help page and by the Requirements folds.
export function IntegrationBlocks({ e }) {
  return (
    <div>
      {e.urls && e.urls.length > 0 && (
        <Block title="Addresses">
          <table className="t-small" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {e.urls.map((u, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 500, padding: '6px 12px 6px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>{u.label}</th>
                  <td style={{ padding: '6px 0' }}><span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{u.value}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}
      {e.ports && <Block title="Network"><p className="t-small m-0">{e.ports}</p></Block>}
      {e.credentials && e.credentials.length > 0 && <Block title="Credentials"><Items items={e.credentials} /></Block>}
      {e.permissions && e.permissions.length > 0 && <Block title="Permissions"><Items items={e.permissions} /></Block>}
      {e.limits && e.limits.length > 0 && <Block title="Limits"><Items items={e.limits} /></Block>}
      {e.where && <Block title="Where in the app"><p className="t-small m-0">{e.where}</p></Block>}
      {e.notes && e.notes.length > 0 && <Block title="Notes"><Items items={e.notes} /></Block>}
    </div>
  );
}

export function CopyTextButton({ e }) {
  const [state, setState] = useState('');
  const copy = async () => {
    const text = entryToText(e);
    try {
      await navigator.clipboard.writeText(text);
      setState('Copied');
    } catch {
      setState('Copy failed');
    }
    setTimeout(() => setState(''), 2000);
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" size="sm" onClick={copy}>Copy as text</Button>
      <span className="t-small text-muted" role="status" aria-live="polite">{state}</span>
    </span>
  );
}

function FoldBody({ id }) {
  const q = useQuery('/help/integrations/' + id, {}, { events: [] });
  return (
    <DataState q={q} skeleton={<SkeletonCard height={120} />}>
      {(e) => (<div><IntegrationBlocks e={e} /><div style={{ marginTop: 12 }}><CopyTextButton e={e} /></div></div>)}
    </DataState>
  );
}

// Collapsed "Requirements" fold for a settings panel. Fetches only when opened.
export function RequirementsFold({ id }) {
  const [open, setOpen] = useState(false);
  return (
    <details data-testid={'requirements-' + id} open={open} onToggle={(ev) => setOpen(ev.currentTarget.open)} style={{ marginTop: 12, marginBottom: 12 }}>
      <summary className="t-small" style={{ cursor: 'pointer', fontWeight: 600 }}>Requirements</summary>
      <div style={{ marginTop: 8 }}>
        {open && <FoldBody id={id} />}
        <p className="t-small m-0" style={{ marginTop: 12 }}><Link to={'/help?tab=' + id}>Open help</Link></p>
      </div>
    </details>
  );
}

export function KindChip({ kind }) {
  return <Chip tone="outline">{kind === 'source' ? 'Data source' : kind === 'identity' ? 'Identity' : 'Vendor connector'}</Chip>;
}
