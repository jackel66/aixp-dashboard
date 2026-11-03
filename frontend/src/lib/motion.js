// Motion budget: nothing over 400 ms, stagger step 40 ms. Reduced motion is handled by the
// browser media query in CSS and by the reducedMotion() check in components.
export const STAGGER = 0.04;
export const container = {
  hidden: {},
  show: { transition: { staggerChildren: STAGGER, delayChildren: 0.02 } }
};
export const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } }
};
export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
