import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useLive } from '../lib/live.jsx';
import { isMock } from '../lib/api.js';
import ThemeToggle from './ThemeToggle.jsx';

// Slim top header: wordmark, live state, theme and Settings. Section navigation is the
// left Sidebar.
export default function Nav() {
  const { connected } = useLive();
  const live = isMock ? 'Mock data' : connected ? 'Live' : 'Offline';
  return (
    <header className="sticky top-0 z-40 bg-bg-1 border-b border-line">
      <nav aria-label="Global" className="flex items-center gap-2" style={{ padding: '10px 24px', minHeight: 56 }}>
        <Link to="/" className="flex items-center gap-2 no-underline" aria-label="AIxP home">
          <span className="font-display" style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>AIxP</span>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 9999, background: 'var(--accent)' }} />
        </Link>
        <span className="t-small text-muted hidden md:inline" style={{ marginLeft: 8 }}>AI platform economics</span>
        <span className="flex-1" />
        <span className="flex items-center gap-2 t-small text-muted mr-2" title={live === 'Live' ? 'Receiving live updates' : live === 'Mock data' ? 'Serving bundled mock data' : 'Live updates are offline'}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 9999, background: live === 'Live' ? 'var(--ok)' : 'var(--faint)' }} />
          {live}
        </span>
        <ThemeToggle />
        <NavLink to="/settings" className="nav-link" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M3.4 12.6l1.4-1.4 M11.2 4.8l1.4-1.4" />
          </svg>
          <span className="t-small hidden lg:inline">Settings</span>
        </NavLink>
      </nav>
    </header>
  );
}
