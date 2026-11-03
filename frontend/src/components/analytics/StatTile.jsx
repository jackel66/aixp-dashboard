import React from 'react';
import CountUp from '../CountUp.jsx';
import Sparkline from './Sparkline.jsx';
import { pctChange } from '../../lib/format.js';
import UnitBadge from '../ui/UnitBadge.jsx';

export { pctChange };

// Delta against a prior period. Neutral colour on purpose: spend rising is a fact, not a verdict.
// The direction is carried by a glyph and a signed number.
export function DeltaChip({ change, label = 'vs prior period' }) {
  if (change === null || change === undefined || !Number.isFinite(change)) return null;
  const rounded = Math.round(change * 10) / 10;
  const text = rounded === 0 ? '0.0%' : (rounded > 0 ? '+' : '-') + Math.abs(rounded).toFixed(1) + '%';
  const path = rounded > 0 ? 'M2 8l4-5 4 5z' : rounded < 0 ? 'M2 4l4 5 4-5z' : 'M2 6h8';
  return (
    <span className="delta" title={'Change ' + label}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d={path} fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /></svg>
      <span className="num">{text}</span>
      <span className="sr-only"> {label}</span>
    </span>
  );
}

// label: small uppercase heading; value + format via CountUp; unit: optional UnitBadge;
// sub: one line of context (basis or comparison); spark: number[]; sparkColor: colour for the line.
export default function StatTile({ label, value, format, change, unit, sub, spark, sparkColor, sparkPlatform, ready = true }) {
  return (
    <div className="an-tile">
      {spark && <Sparkline values={spark} color={sparkColor} platform={sparkPlatform} ready={ready} />}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="t-micro text-muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600 }}>{label}</div>
        <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 4 }}>
          <span className="t-stat text-ink"><CountUp value={value} format={format} /></span>
          {unit && <UnitBadge unit={unit} />}
          <DeltaChip change={change} />
        </div>
        {sub && <div className="t-micro text-muted" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}
export { StatTile };
