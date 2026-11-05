import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../../lib/query.js';
import { money, units, pct } from '../../lib/format.js';
import { platformName } from '../../lib/platforms.js';

// Body of the hover card for one matrix cell: top five contributors and a link to the Users page
// filtered the same way. Mounted only while the card is open, so the query runs on demand.
export default function MatrixCellCard({ dim, rowKey, rowLabel, platform, canLink = true }) {
  const q = useQuery('/organization/cell', { dim, key: rowKey, platform });
  const d = q.data;
  const filter = new URLSearchParams();
  filter.set(dim, rowLabel);
  filter.set('platform', platform);
  return (
    <div style={{ textAlign: 'left' }}>
      <div className="t-h3" style={{ marginBottom: 2 }}>{rowLabel}</div>
      <div className="text-muted t-small" style={{ marginBottom: 8 }}>{platformName(platform)}, top contributors by spend in US dollars</div>
      {q.error && d === undefined && (q.error.body && q.error.body.code === 'out_of_scope'
        ? <p className="m-0 text-muted">That group is outside your data scope.</p>
        : <p className="m-0 text-muted">Could not load contributors.</p>)}
      {d === undefined && !q.error && <p className="m-0 text-muted">Loading contributors.</p>}
      {d && (
        <>
          {d.contributors_hidden && <p className="m-0 text-muted t-small">Contributors need the people.view permission</p>}
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            {d.contributors.map((c) => (
              <li key={c.person_key} className="flex items-center justify-between gap-3">
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.display_name || c.person_key}</span>
                <span className="num text-muted" style={{ whiteSpace: 'nowrap' }}>{money(c.usd)}, {units(c.consumption.value, c.consumption.unit)}</span>
              </li>
            ))}
            {!d.contributors.length && !d.contributors_hidden && <li className="text-muted">No identified contributors.</li>}
          </ul>
          <p className="m-0 t-small text-muted" style={{ marginTop: 8 }}>
            {pct(d.share_of_row * 100, 0)} of this row, {pct(d.share_of_column * 100, 0)} of this platform.
          </p>
        </>
      )}
      {canLink && <Link to={'/users?' + filter.toString()} className="inline-block" style={{ marginTop: 8, fontWeight: 600 }}>View users</Link>}
    </div>
  );
}
