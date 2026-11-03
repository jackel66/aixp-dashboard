import React, { useId } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import useFocusTrap from './useFocusTrap.js';

function Panel({ title, onClose, footer, children, width }) {
  const ref = useFocusTrap(true, onClose);
  const titleId = useId();
  return (
    <motion.div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="relative bg-bg-1 rounded-xl w-full max-h-[90vh] flex flex-col border border-line"
      style={{ maxWidth: width, boxShadow: 'var(--shadow-2)' }}
      initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.98, opacity: 0 }} transition={{ duration: 0.18 }}>
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <h2 id={titleId} className="t-h2 m-0">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-ink text-xl leading-none px-1 bg-transparent border-0 cursor-pointer">x</button>
      </div>
      <div className="px-6 pb-4 overflow-auto text-sm text-ink">{children}</div>
      {footer && <div className="px-6 py-4 border-t border-line flex justify-end gap-2">{footer}</div>}
    </motion.div>
  );
}

export default function Dialog({ open, title, onClose, footer, children, width = 480 }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden="true" />
          <Panel title={title} onClose={onClose} footer={footer} width={width}>{children}</Panel>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
export { Dialog };
