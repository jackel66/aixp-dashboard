import React, { useState } from 'react';

// Lightweight CSS-positioned tooltip. Wraps children; shows text on hover or focus.
export default function Tooltip({ text, children, side = 'bottom', className = '' }) {
  const [show, setShow] = useState(false);
  if (!text) return children;
  const pos = side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
  return (
    <span className={'relative inline-flex ' + className}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)} onBlur={() => setShow(false)}>
      {children}
      {show && (
        <span role="tooltip" className={'pointer-events-none absolute left-1/2 -translate-x-1/2 z-[90] w-max max-w-[260px] whitespace-normal rounded-md bg-t3-navy px-2.5 py-1.5 text-xs font-normal leading-snug text-white shadow-lg ' + pos}>
          {text}
        </span>
      )}
    </span>
  );
}
export { Tooltip };
