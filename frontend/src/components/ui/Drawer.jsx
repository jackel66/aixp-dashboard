import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export default function Drawer({ open, side = 'right', width = 480, title, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const from = side === 'left' ? -width : width;
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70]">
          <motion.div className="absolute inset-0 bg-t3-navy/30" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} />
          <motion.aside role="dialog" aria-label={title}
            className={'absolute top-0 bottom-0 bg-white shadow-2xl flex flex-col ' + (side === 'left' ? 'left-0' : 'right-0')}
            style={{ width, maxWidth: '100vw' }}
            initial={{ x: from }} animate={{ x: 0 }} exit={{ x: from }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-t3-smoke">
              <h2 className="text-base font-bold text-t3-navy m-0">{title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="text-t3-grey hover:text-t3-navy text-xl leading-none px-1">x</button>
            </div>
            <div className="flex-1 overflow-auto p-5 text-sm">{children}</div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
export { Drawer };
