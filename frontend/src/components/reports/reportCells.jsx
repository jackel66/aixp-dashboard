import React from 'react';
import { DeltaChip } from '../analytics/StatTile.jsx';
import UnitBadge from '../ui/UnitBadge.jsx';
import { platformName } from '../../lib/platforms.js';
import { money, moneyFull, count, compactCount, pct, dateLong } from '../../lib/format.js';

const NUMERIC = new Set(['money', 'number', 'units', 'pct', 'delta']);
export const isNumericType = (t) => NUMERIC.has(t);

export function PlatformMark({ id }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--p-' + id + ')', display: 'inline-block' }} />
      {platformName(id)}
    </span>
  );
}

function blank(v) { return v === null || v === undefined || v === ''; }

// Render one cell by column type. openUser is used for the text column that names a user.
export function renderCell(col, row, openUser) {
  const v = row[col.key];
  if (blank(v)) return '-';
  switch (col.type) {
    case 'money': return <span title={moneyFull(v)}>{money(v)}</span>;
    case 'number': return count(v);
    case 'pct': return pct(v);
    case 'date': return dateLong(v);
    case 'platform': return <PlatformMark id={v} />;
    case 'units': {
      const o = typeof v === 'object' ? v : { value: v, unit: '' };
      return <span className="inline-flex items-center gap-2 justify-end">{compactCount(o.value)} <UnitBadge unit={o.unit} /></span>;
    }
    case 'delta': {
      if (typeof v !== 'object') return money(v);
      // Show the signed difference, not the current figure (that has its own column).
      const d = Number.isFinite(Number(v.delta)) ? Number(v.delta) : (Number(v.now) || 0) - (Number(v.prev) || 0);
      return (
        <span className="inline-flex items-center gap-2 justify-end">
          {(d > 0 ? '+' : d < 0 ? '-' : '') + money(Math.abs(d))}
          <DeltaChip change={v.pct === null || v.pct === undefined ? null : Number(v.pct)} label="vs previous" />
        </span>
      );
    }
    default:
      if (col.key === 'user' && row.person_key && openUser) {
        return (
          <button type="button" className="row-button" onClick={() => openUser(row.person_key)}>{String(v)}</button>
        );
      }
      return String(v);
  }
}
