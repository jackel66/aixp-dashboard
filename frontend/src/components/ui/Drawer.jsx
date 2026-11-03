import React, { useId } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import useFocusTrap from './useFocusTrap.js';

function Panel({ title, onClose, width, side, children }) {
  const ref = useFocusTrap(true, onClose);
  const titleId = useId();
  const from = side === 'left' ? -width : width;
  return (
    <motion.aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className={'absolute top-0 bottom-0 bg-bg-1 flex flex-col border-line ' + (side === 'left' ? 'left-0 border-r' : 'right-0 border-l')}
      style={{ width, maxWidth: '100vw', boxShadow: 'var(--shadow-2)' }}
      initial={{ x: from }} animate={{ x: 0 }} exit={{ x: from }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-line">
        <h2 id={titleId} className="t-h2 m-0">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-ink text-xl leading-none px-1 bg-transparent border-0 cursor-pointer">x</button>
      </div>
      <div className="flex-1 overflow-auto p-5 text-sm">{children}</div>
    </motion.aside>
  );
}

// Right drawer, 520 px by default. Focus is trapped, Esc closes, focus returns to the opener.
export default function Drawer({ open, side = 'right', width = 520, title, onClose, children }) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70]">
          <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden="true"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} />
          <Panel title={title} onClose={onClose} width={width} side={side}>{children}</Panel>
        </div>
      )}
    </AnimatePresence>
  );
}
export { Drawer };
