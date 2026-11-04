import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { buildUrl } from '../../lib/query.js';

// Typeahead over GET /access/directory/search. type is user, group or ou. Calls onPick(row).
// disabledReason set = the control is disabled and the reason shows beneath it.
export function rowLabel(type, r) {
  if (type === 'user') return (r.display_name || r.sam) + ' (' + (r.upn || r.sam) + ')' + (r.disabled ? ', disabled in AD' : '');
  if (type === 'group') return r.name + (r.description ? ' - ' + r.description : '');
  return r.name + (r.path && r.path !== r.name ? ' (' + r.path + ')' : '');
}

export default function DirectoryPicker({ type, onPick, disabledReason, placeholder, label, exclude = [], id }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const box = useRef(null);

  useEffect(() => {
    if (disabledReason || !open) return undefined;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.get(buildUrl('/access/directory/search', { type, q: q.trim() }));
        if (n !== seq.current) return;
        setRows(Array.isArray(r) ? r : (r && r.rows) || []);
        setErr('');
      } catch (e) {
        if (n !== seq.current) return;
        setRows([]);
        setErr(e.message || 'Search failed');
      } finally { if (n === seq.current) setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, type, open, disabledReason]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);

  const shown = rows.filter((r) => !exclude.some((d) => String(d).toLowerCase() === String(r.dn).toLowerCase()));
  return (
    <div ref={box} className="relative" style={{ maxWidth: 420 }}>
      <input id={id} className="input w-full" type="text" autoComplete="off" spellCheck={false} aria-label={label}
        placeholder={disabledReason ? 'Unavailable' : placeholder} disabled={!!disabledReason} value={q}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
      {disabledReason && <p className="t-small text-muted m-0" style={{ marginTop: 4 }}>{disabledReason}</p>}
      {open && !disabledReason && (
        <div className="absolute z-[70] bg-bg-1 border border-line rounded-lg w-full" style={{ top: '100%', marginTop: 4, maxHeight: 260, overflow: 'auto', boxShadow: 'var(--shadow-2)' }}>
          {busy && <div className="t-small text-muted" style={{ padding: 8 }} role="status">Searching</div>}
          {!busy && err && <div className="t-small" style={{ padding: 8, color: 'var(--fail)' }} role="alert">{err}</div>}
          {!busy && !err && !shown.length && <div className="t-small text-muted" style={{ padding: 8 }}>No matches.</div>}
          <ul className="list-none m-0 p-0">
            {shown.map((r) => (
              <li key={r.dn}>
                <button type="button" className="side-link w-full bg-transparent border-0 cursor-pointer" style={{ font: 'inherit', height: 'auto', minHeight: 32, padding: '6px 10px', textAlign: 'left' }}
                  onClick={() => { onPick(r); setOpen(false); setQ(''); }}>
                  {rowLabel(type, r)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
