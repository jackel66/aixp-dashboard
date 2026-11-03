import React from 'react';

// Status is never colour alone: each state has a glyph and a word.
const META = {
  pass: { label: 'Passed', cls: 'chip-ok', color: 'var(--ok)', path: 'M3 8.5l3.2 3L13 4.5' },
  warn: { label: 'Warning', cls: 'chip-warn', color: 'var(--warn)', path: 'M8 3l6 10H2z M8 7v3 M8 11.6v.4' },
  fail: { label: 'Failed', cls: 'chip-fail', color: 'var(--fail)', path: 'M4 4l8 8 M12 4l-8 8' },
  info: { label: 'Info', cls: '', color: 'var(--muted)', path: 'M8 7v5 M8 4.2v.4' },
  skip: { label: 'Skipped', cls: 'chip-outline', color: 'var(--faint)', path: 'M4 8h8' }
};

export default function StatusChip({ status = 'info', children, className = '' }) {
  const m = META[status] || META.info;
  return (
    <span className={'chip ' + m.cls + ' ' + className}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={m.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={m.path} /></svg>
      {children || m.label}
    </span>
  );
}
export { StatusChip };
