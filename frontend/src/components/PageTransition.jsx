import React from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import { reducedMotion } from '../lib/motion.js';

// Keyed by the first path segment, so moving between /platforms/:id pages does not replay the
// page entrance (the platform page cross-fades its own content instead).
export default function PageTransition({ children }) {
  const { pathname } = useLocation();
  const key = pathname.split('/')[1] || 'home';
  const reduce = reducedMotion();
  return (
    <motion.div
      key={key}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="flex-1 flex flex-col min-w-0"
    >
      {children}
    </motion.div>
  );
}
