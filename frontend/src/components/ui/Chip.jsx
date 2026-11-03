import React from 'react';

const TONES = {
  green: 'bg-xl-green text-[#27501a]',
  amber: 'bg-xl-amber text-[#6b5200]',
  red: 'bg-xl-red text-[#8a2222]',
  gray: 'bg-xl-gray text-[#34415f]',
  blue: 'bg-xl-new text-[#14507a]',
  navy: 'bg-t3-navy text-white'
};

export function Chip({ tone = 'gray', className = '', children, ...rest }) {
  return (
    <span className={'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ' + (TONES[tone] || TONES.gray) + ' ' + className} {...rest}>
      {children}
    </span>
  );
}

export const RAG_TONE = { Green: 'green', Amber: 'amber', Red: 'red', Gray: 'gray', 'Not Updated': 'gray' };
export const MOVE_TONE = { Advanced: 'green', Unchanged: 'amber', Slipped: 'red', New: 'blue', 'Not Updated': 'gray' };
export const STAGE_TONE = { 'No Opp': 'gray', Discovery: 'blue', Upside: 'amber', Commit: 'green' };

export function RagChip({ value, ...rest }) {
  if (!value) return null;
  return <Chip tone={RAG_TONE[value] || 'gray'} {...rest}>{value}</Chip>;
}
export function MovementChip({ value, ...rest }) {
  if (!value) return null;
  return <Chip tone={MOVE_TONE[value] || 'gray'} {...rest}>{value}</Chip>;
}
export function StageChip({ value, ...rest }) {
  if (!value) return null;
  return <Chip tone={STAGE_TONE[value] || 'gray'} {...rest}>{value}</Chip>;
}
export default Chip;
