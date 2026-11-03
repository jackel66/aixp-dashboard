import React from 'react';
import CountUp from '../CountUp.jsx';
import Sparkline from './Sparkline.jsx';

// Percent change of cur against prev. Returns null when there is no usable base.
export function pctChange(cur, prev) {
  const c = Number(cur);
  const p = Number(prev);
  if (prev === null || prev === undefined || !Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

// invert: fewer is better, so up is red and down is green.
export function DeltaChip({ change, invert = false }) {
  if (change === null || change === undefined) return null;
  const rounded = Math.round(change * 10) / 10;
  const dir = rounded === 0 ? 'flat' : (rounded > 0) === !invert ? 'up' : 'down';
  const text = rounded === 0 ? '0%' : (rounded > 0 ? '+' : '-') + Math.abs(rounded).toFixed(1) + '%';
  return <span className={'an-chip ' + dir} title="Change against the last period">{text}</span>;
}

export default function StatTile({ label, value, format, change, invert, sub, spark, ready }) {
  return (
    <div className="an-tile">
      {spark && <Sparkline values={spark} ready={ready} />}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="text-t3-grey" style={{ fontSize: 11, lineHeight: '14px', textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600 }}>{label}</div>
        <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
          <span className="text-t3-navy" style={{ fontSize: 24, fontWeight: 700, lineHeight: '30px' }}>
            <CountUp value={value} format={format} />
          </span>
          <DeltaChip change={change} invert={invert} />
        </div>
        {sub && <div className="text-t3-grey" style={{ fontSize: 11, lineHeight: '15px', marginTop: 2, whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
    </div>
  );
}
