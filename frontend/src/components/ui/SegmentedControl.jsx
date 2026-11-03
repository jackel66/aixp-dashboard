import React, { useId } from 'react';

// A radio group styled as a segmented control. Arrow keys move the selection natively.
export default function SegmentedControl({ label, value, options, onChange, className = '' }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={'seg ' + className}>
      {options.map((o) => (
        <label key={o.value}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
export { SegmentedControl };
