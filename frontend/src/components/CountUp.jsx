import React, { useEffect, useRef, useState } from 'react';
import { animate } from 'framer-motion';

// <CountUp value={n} format={fn} duration={500} />
// Re-animates from the previous value; jumps when the user prefers reduced motion.
export default function CountUp({ value, format = (n) => String(Math.round(n)), duration = 500, className = '' }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(target);
  const prev = useRef(target);

  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || prev.current === target) {
      prev.current = target;
      setShown(target);
      return undefined;
    }
    const controls = animate(prev.current, target, {
      duration: duration / 1000,
      ease: 'easeOut',
      onUpdate: (v) => setShown(v),
      onComplete: () => { prev.current = target; setShown(target); }
    });
    prev.current = target;
    return () => controls.stop();
  }, [target, duration]);

  return <span className={className}>{format(shown)}</span>;
}
export { CountUp };
