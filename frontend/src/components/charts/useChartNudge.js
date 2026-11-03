import { useEffect, useRef } from 'react';

// Chart.js sizes itself from its parent when it mounts. If that happens while the tab is hidden,
// mid page transition, or before web fonts settle, the canvas can stay blank or wrongly sized,
// so nudge a resize shortly after mount, when fonts are ready, when the tab becomes visible and
// on window resize (Chart.js only observes its parent element).
export function useChartNudge() {
  const ref = useRef(null);
  useEffect(() => {
    const nudge = () => {
      const c = ref.current;
      if (c && typeof c.resize === 'function') {
        try { c.resize(); c.update('none'); } catch (e) { console.error('[chart nudge] ' + (e && e.message), e); }
      }
    };
    let tr = null;
    const onResize = () => { clearTimeout(tr); tr = setTimeout(nudge, 150); };
    const t1 = setTimeout(nudge, 80);
    const t2 = setTimeout(nudge, 500);
    const onVis = () => { if (!document.hidden) nudge(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('resize', onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(nudge).catch(() => {});
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(tr);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return ref;
}

// Remount key: the SET of labels (plus dataset count). A new stage, rep or client remounts the
// chart so Chart.js never reconciles a different shape in place; value changes update in place.
// Items may be plain labels or [label, value] entries.
export function sig(items, datasetCount = 1) {
  return (items || []).map((e) => (Array.isArray(e) ? e[0] : e)).join('|') + '#' + datasetCount;
}
