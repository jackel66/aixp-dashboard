import React, { useId, useState } from 'react';

// One-line tooltip. Shows on hover and keyboard focus; wraps a single focusable child.
export default function Tooltip({ text, children, side = 'bottom', className = '' }) {
  const [show, setShow] = useState(false);
  const id = useId();
  if (!text) return children;
  const pos = side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
  return (
    <span className={'relative inline-flex ' + className} aria-describedby={show ? id : undefined}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)} onBlur={() => setShow(false)}>
      {children}
      {show && (
        <span id={id} role="tooltip" className={'pointer-events-none absolute left-1/2 -translate-x-1/2 z-[90] w-max max-w-[260px] whitespace-normal rounded-lg bg-bg-1 border border-line px-2.5 py-1.5 t-small text-ink ' + pos} style={{ boxShadow: 'var(--shadow-2)' }}>
          {text}
        </span>
      )}
    </span>
  );
}
export { Tooltip };
