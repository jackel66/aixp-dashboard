import React from 'react';

const VARIANTS = {
  primary: 'bg-accent text-on-accent hover:opacity-90 border border-transparent',
  secondary: 'bg-bg-1 text-ink border border-line hover:bg-bg-2',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-bg-2',
  danger: 'bg-fail text-white hover:opacity-90 border border-transparent'
};
const SIZES = {
  sm: 'text-xs px-3 h-7',
  md: 'text-sm px-4 h-9'
};

export default function Button({ variant = 'primary', size = 'md', className = '', type = 'button', as: As = 'button', children, ...rest }) {
  const cls = 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold cursor-pointer no-underline transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed '
    + VARIANTS[variant] + ' ' + SIZES[size] + ' ' + className;
  if (As === 'button') return <button type={type} className={cls} {...rest}>{children}</button>;
  return <As className={cls} {...rest}>{children}</As>;
}
export { Button };
