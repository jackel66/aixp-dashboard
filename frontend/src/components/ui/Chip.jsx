import React from 'react';

const TONES = {
  gray: '',
  accent: 'chip-accent',
  ok: 'chip-ok',
  warn: 'chip-warn',
  fail: 'chip-fail',
  outline: 'chip-outline'
};

export function Chip({ tone = 'gray', className = '', children, ...rest }) {
  return <span className={'chip ' + (TONES[tone] || '') + ' ' + className} {...rest}>{children}</span>;
}
export default Chip;
