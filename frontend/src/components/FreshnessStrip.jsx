import React from 'react';
import { dateLong, lag } from '../lib/format.js';
import StatusChip from './ui/StatusChip.jsx';

// One chip per platform: its own as-of date and lag. A stale platform is flagged with a warning
// glyph and the word, so a current overall maximum can never hide it.
export default function FreshnessStrip({ platforms }) {
  return (
    <ul className="flex flex-wrap gap-2 list-none p-0 m-0" aria-label="Data freshness per platform">
      {platforms.map((p) => (
        <li key={p.id} className={'chip ' + (p.stale ? 'chip-warn' : '')} style={{ height: 28 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 3, background: 'var(--p-' + p.id + ')' }} />
          <span style={{ fontWeight: 600 }}>{p.name}</span>
          <span className="text-muted">as of {dateLong(p.as_of)}</span>
          {p.stale
            ? <StatusChip status="warn" className="" >{lag(p.lag_days, true)}</StatusChip>
            : <span className="text-muted">{lag(p.lag_days, false)}</span>}
        </li>
      ))}
    </ul>
  );
}
