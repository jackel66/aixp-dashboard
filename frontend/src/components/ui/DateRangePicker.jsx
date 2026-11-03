import React, { useState } from 'react';
import { addDays } from '../../lib/format.js';
import SegmentedControl from './SegmentedControl.jsx';

const PRESETS = [
  { value: '1', label: '24 hours', n: 1 },
  { value: '7', label: '7 days', n: 7 },
  { value: '30', label: '30 days', n: 30 },
  { value: '90', label: '90 days', n: 90 },
  { value: '180', label: '6 months', n: 180 },
  { value: '365', label: '12 months', n: 365 },
  { value: 'custom', label: 'Custom' }
];

// Presets end on asOf. value: { from, to }. onChange({ from, to }).
export default function DateRangePicker({ from, to, asOf, onChange }) {
  const [custom, setCustom] = useState(false);
  let current = 'custom';
  if (asOf && to === asOf) {
    const hit = PRESETS.find((p) => p.n && from === addDays(asOf, -(p.n - 1)));
    if (hit) current = hit.value;
  }
  const showCustom = custom || current === 'custom';
  function pick(v) {
    if (v === 'custom') { setCustom(true); return; }
    setCustom(false);
    const p = PRESETS.find((x) => x.value === v);
    onChange({ from: addDays(asOf, -(p.n - 1)), to: asOf });
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <SegmentedControl label="Date range" value={showCustom ? 'custom' : current} options={PRESETS} onChange={pick} />
      {showCustom && (
        <span className="flex items-center gap-2">
          <label className="t-small text-muted">From <input className="input" type="date" value={from || ''} max={to || undefined} onChange={(e) => e.target.value && onChange({ from: e.target.value, to })} /></label>
          <label className="t-small text-muted">To <input className="input" type="date" value={to || ''} min={from || undefined} max={asOf || undefined} onChange={(e) => e.target.value && onChange({ from, to: e.target.value })} /></label>
        </span>
      )}
    </div>
  );
}
export { DateRangePicker };
