import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Traps Tab inside containerRef while active, moves focus in on open and returns it to the
// previously focused element on close. Esc calls onEscape.
export default function useFocusTrap(active, onEscape) {
  const containerRef = useRef(null);
  const escRef = useRef(onEscape);
  escRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement;
    const node = containerRef.current;
    const focusables = () => (node ? Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement) : []);
    const t = setTimeout(() => {
      if (!node) return;
      const first = focusables()[0];
      if (first) first.focus(); else { node.setAttribute('tabindex', '-1'); node.focus(); }
    }, 0);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (escRef.current) escRef.current(); return; }
      if (e.key !== 'Tab' || !node) return;
      const list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0]; const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [active]);

  return containerRef;
}
export { useFocusTrap };
