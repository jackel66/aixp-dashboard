import React from 'react';
import DateRangePicker from './ui/DateRangePicker.jsx';
import SegmentedControl from './ui/SegmentedControl.jsx';
import { BASES } from '../lib/platforms.js';

// Range and basis controls in one row above the charts. values/set come from useUrlFilters.
export default function FilterBar({ values, set, asOf, range, showBasis = true, showRange = true, children }) {
  return (
    <div className="flex items-center gap-4 flex-wrap" style={{ marginBottom: 16 }}>
      {showRange && range && (
        <DateRangePicker from={range.from} to={range.to} asOf={asOf} onChange={(r) => set({ from: r.from, to: r.to })} />
      )}
      {showBasis && <SegmentedControl label="Spend basis" value={values.basis} options={BASES} onChange={(v) => set({ basis: v })} />}
      {children}
    </div>
  );
}
