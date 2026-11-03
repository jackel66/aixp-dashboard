import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// Rich hover content. Opens on hover (150 ms delay) and on keyboard focus, closes 80 ms after
// leaving, Esc closes. It is never the only path to an action: put actions in the page too.
export default function HoverCard({ trigger, children, width = 280, placement = 'bottom', className = '' }) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const id = useId();

  const show = useCallback((delay) => {
    clearTimeout(closeTimer.current);
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), delay);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 80);
  }, []);
  useEffect(() => () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); }, []);

  const pos = placement === 'top' ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 6 };
  return (
    <span className={'relative inline-flex ' + className}
      onMouseEnter={() => show(150)} onMouseLeave={hide}
      onFocus={() => show(0)} onBlur={hide}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
      aria-describedby={open ? id : undefined}>
      {trigger}
      <AnimatePresence>
        {open && (
          <motion.div id={id} role="tooltip"
            className="absolute left-0 z-[60] bg-bg-1 border border-line rounded-xl p-3 text-sm text-ink"
            style={{ width, boxShadow: 'var(--shadow-2)', ...pos }}
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.12 } }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}
export { HoverCard };
