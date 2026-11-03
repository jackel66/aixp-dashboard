import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { PLATFORMS } from '../lib/platforms.js';
import { useLive } from '../lib/live.jsx';
import { isMock } from '../lib/api.js';
import ThemeToggle from './ThemeToggle.jsx';

const ITEMS = [
  { to: '/overview', label: 'Overview' },
  { menu: 'platforms' },
  { to: '/organization', label: 'Organization' },
  { to: '/models', label: 'Models' },
  { to: '/users', label: 'Users' },
  { to: '/data-quality', label: 'Data quality' },
  { to: '/settings', label: 'Settings' }
];

function PlatformsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { pathname } = useLocation();
  const active = pathname.startsWith('/platforms');
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={'nav-link' + (active ? ' active' : '')} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Platforms
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul className="absolute left-0 top-full mt-1 z-50 list-none m-0 p-1 bg-bg-1 border border-line rounded-xl" style={{ minWidth: 200, boxShadow: 'var(--shadow-2)' }}>
          {PLATFORMS.map((p) => (
            <li key={p.id}>
              <Link to={'/platforms/' + p.id} className="nav-link w-full" style={{ width: '100%' }}>
                <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 3, background: 'var(--p-' + p.id + ')' }} />
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Nav() {
  const { connected } = useLive();
  const live = isMock ? 'Mock data' : connected ? 'Live' : 'Offline';
  return (
    <header className="sticky top-0 z-40 bg-bg-1 border-b border-line">
      <nav aria-label="Primary" className="page flex items-center gap-2" style={{ paddingTop: 10, paddingBottom: 10, minHeight: 56 }}>
        <Link to="/" className="flex items-center gap-2 no-underline mr-4" aria-label="AIxP home">
          <span className="font-display" style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>AIxP</span>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 9999, background: 'var(--accent)' }} />
        </Link>
        <div className="flex items-center gap-1 flex-wrap flex-1">
          {ITEMS.map((it) => (it.menu
            ? <PlatformsMenu key="platforms" />
            : <NavLink key={it.to} to={it.to} className="nav-link">{it.label}</NavLink>))}
        </div>
        <span className="flex items-center gap-2 t-small text-muted mr-2" title={live === 'Live' ? 'Receiving live updates' : live === 'Mock data' ? 'Serving bundled mock data' : 'Live updates are offline'}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 9999, background: live === 'Live' ? 'var(--ok)' : 'var(--faint)' }} />
          {live}
        </span>
        <ThemeToggle />
      </nav>
    </header>
  );
}
