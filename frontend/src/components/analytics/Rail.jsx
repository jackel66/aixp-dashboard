import React, { useEffect, useState } from 'react';
import Button from '../ui/Button.jsx';

export const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'people', label: 'People and clients' },
  { id: 'timing', label: 'Timing' },
  { id: 'bridge', label: 'Week over week' },
  { id: 'slips', label: 'Slips' },
  { id: 'quarters', label: 'By quarter' },
  { id: 'pathway-risk', label: 'Pathway risk' },
  { id: 'movement', label: 'Movement' },
  { id: 'attention', label: 'Attention' }
];
const IDS = SECTIONS.map((s) => s.id);

function Select({ label, value, options, onChange }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="an-rail-select">
      <option value="">{label}</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// Tracks which section is in view (the topmost one that intersects the band under the top bar).
function useActiveSection() {
  const [active, setActive] = useState(IDS[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) seen.add(e.target.id); else seen.delete(e.target.id); });
      const first = IDS.find((id) => seen.has(id));
      if (first) setActive(first);
    }, { rootMargin: '-90px 0px -60% 0px', threshold: 0 });
    IDS.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  return [active, setActive];
}

export default function Rail({ rep, client, reps, clients, onFilter, onClear, activeCount, compareLabel }) {
  const [active, setActive] = useActiveSection();
  const go = (e, id) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(id); }
  };
  const filtered = !!(rep || client);
  return (
    <aside className="an-rail" aria-label="Analytics filters and sections">
      <div className="an-rail-block">
        <h1 className="text-t3-navy m-0" style={{ fontSize: 18, fontWeight: 700, lineHeight: '24px' }}>Analytics</h1>
        <p className="text-t3-grey m-0" style={{ fontSize: 11, lineHeight: '15px', marginTop: 2 }}>Live FSG pipeline. Every figure follows the filters.</p>
      </div>
      <div className="an-rail-block">
        <h2 className="an-rail-h">Filters</h2>
        <div className="an-rail-filters">
          <Select label="All reps" value={rep} options={reps} onChange={(v) => onFilter('rep', v)} />
          <Select label="All clients" value={client} options={clients} onChange={(v) => onFilter('client', v)} />
          {filtered && <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>}
        </div>
        {filtered && (
          <p className="text-t3-grey m-0" style={{ fontSize: 11, lineHeight: '15px', marginTop: 4 }}>
            {'Showing ' + activeCount + ' active opportunities for ' + [rep && 'rep ' + rep, client && 'client ' + client].filter(Boolean).join(', ')}
          </p>
        )}
      </div>
      <nav className="an-rail-block" aria-label="Sections">
        <h2 className="an-rail-h">Sections</h2>
        <div className="an-sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={'#' + s.id} onClick={(e) => go(e, s.id)} className={'an-link' + (active === s.id ? ' on' : '')} aria-current={active === s.id ? 'true' : undefined}>
              {s.label}
            </a>
          ))}
        </div>
      </nav>
      {compareLabel && (
        <div className="an-rail-block">
          <h2 className="an-rail-h">Compare to</h2>
          <p className="text-t3-ink m-0" style={{ fontSize: 12 }}>{'vs ' + compareLabel}</p>
        </div>
      )}
    </aside>
  );
}
