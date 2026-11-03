import React, { useEffect, useState } from 'react';

// Section rail for long pages. sections: [{ id, label }]. Highlights the section in view and
// scrolls smoothly (instantly under reduced motion). children render above the links (filters).
export default function Rail({ title, sections, children }) {
  const ids = sections.map((s) => s.id);
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) seen.add(e.target.id); else seen.delete(e.target.id); });
      const first = ids.find((id) => seen.has(id));
      if (first) setActive(first);
    }, { rootMargin: '-90px 0px -60% 0px', threshold: 0 });
    ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|')]);
  const go = (e, id) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(id); }
  };
  return (
    <aside className="sticky top-20 flex flex-col gap-4" aria-label={title || 'Sections'} style={{ width: 220 }}>
      {children}
      <nav aria-label="Sections" className="flex flex-col gap-1">
        <h2 className="t-h3 m-0 mb-1">Sections</h2>
        {sections.map((s) => (
          <a key={s.id} href={'#' + s.id} onClick={(e) => go(e, s.id)} className={'nav-link' + (active === s.id ? ' active' : '')} aria-current={active === s.id ? 'true' : undefined}>
            {s.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}
export { Rail };
