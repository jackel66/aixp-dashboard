import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const ToastContext = createContext(null);
const fallback = {
  success: (m) => console.log('[toast]', m),
  error: (m) => console.error('[toast]', m)
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const push = useCallback((kind, message) => {
    const id = ++seq.current;
    setItems((cur) => [...cur.slice(-3), { id, kind, message }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), kind === 'error' ? 5000 : 2800);
  }, []);
  const api = useMemo(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none" role="status" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="rounded-lg px-4 py-2 text-sm font-semibold border border-line bg-bg-1 text-ink flex items-center gap-2" style={{ boxShadow: 'var(--shadow-2)' }}>
              <span aria-hidden="true" style={{ color: t.kind === 'error' ? 'var(--fail)' : 'var(--ok)' }}>{t.kind === 'error' ? '!' : 'v'}</span>
              <span className="sr-only">{t.kind === 'error' ? 'Error: ' : 'Done: '}</span>
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext) || fallback;
}
export default ToastProvider;
