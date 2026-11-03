import React from 'react';

const VARIANTS = {
  primary: 'bg-t3-sky text-white hover:bg-t3-steel border border-transparent',
  secondary: 'bg-white text-t3-navy border border-t3-navy/25 hover:border-t3-sky hover:text-t3-steel',
  ghost: 'bg-transparent text-t3-ink border border-transparent hover:bg-t3-smoke',
  danger: 'bg-t3-red text-white hover:bg-[#d84f4f] border border-transparent'
};
const SIZES = {
  sm: 'text-xs px-3 py-1.5',
  md: 'text-sm px-5 py-2.5'
};

export default function Button({ variant = 'primary', size = 'md', className = '', type = 'button', as: As = 'button', children, ...rest }) {
  const cls = 'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-t3-sky/60 '
    + VARIANTS[variant] + ' ' + SIZES[size] + ' ' + className;
  if (As === 'button') return <button type={type} className={cls} {...rest}>{children}</button>;
  return <As className={cls} {...rest}>{children}</As>;
}
export { Button };
