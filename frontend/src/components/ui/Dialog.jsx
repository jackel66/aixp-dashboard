import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export default function Dialog({ open, title, onClose, footer, children, width = 480 }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0 bg-t3-navy/50" onClick={onClose} />
          <motion.div role="dialog" aria-modal="true" aria-label={title}
            className="relative bg-white rounded-xl shadow-2xl w-full max-h-[90vh] flex flex-col"
            style={{ maxWidth: width }}
            initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 8, scale: 0.98 }} transition={{ duration: 0.18 }}>
            <div className="flex items-center justify-between px-6 pt-5 pb-3">
              <h2 className="text-lg font-bold text-t3-navy m-0">{title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="text-t3-grey hover:text-t3-navy text-xl leading-none px-1">x</button>
            </div>
            <div className="px-6 pb-4 overflow-auto text-sm text-t3-ink">{children}</div>
            {footer && <div className="px-6 py-4 border-t border-t3-smoke flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
export { Dialog };
