import React from 'react';
import { NavLink } from 'react-router-dom';
import { PLATFORMS } from '../lib/platforms.js';

// Left navigation column. Sections and the four platform reports live here; the global
// items (Settings, theme, live state) stay in the top header.
const SECTIONS = [
  { to: '/', label: 'Executive view', end: true },
  { to: '/overview', label: 'Overview' },
  { to: '/organization', label: 'Organization' },
  { to: '/models', label: 'Models' },
  { to: '/users', label: 'Users' },
  { to: '/data-quality', label: 'Data quality' }
];

function Icon({ name }) {
  const d = {
    home: 'M2 8l6-5 6 5v6H2z',
    overview: 'M2 12V7 M6 12V4 M10 12V8 M14 12V2',
    org: 'M2 3h12 M2 8h12 M2 13h12',
    models: 'M3 3h4v4H3z M9 3h4v4H9z M3 9h4v4H3z M9 9h4v4H9z',
    users: 'M8 8a3 3 0 100-6 3 3 0 000 6z M2 14a6 6 0 0112 0',
    quality: 'M8 1.5l5.5 2.5v4c0 3.5-2.5 5.5-5.5 6.5C5 13.5 2.5 11.5 2.5 8V4z M5.5 8l2 2 3-3'
  }[name];
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
const ICONS = { '/': 'home', '/overview': 'overview', '/organization': 'org', '/models': 'models', '/users': 'users', '/data-quality': 'quality' };

export default function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Sections">
      <nav className="sidebar-inner">
        <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink to={s.to} end={s.end} className="side-link">
                <Icon name={ICONS[s.to]} />
                <span>{s.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="t-h3 side-group">Platforms</div>
        <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
          {PLATFORMS.map((p) => (
            <li key={p.id}>
              <NavLink to={'/platforms/' + p.id} className="side-link">
                <span aria-hidden="true" className="side-dot" style={{ background: 'var(--p-' + p.id + ')' }} />
                <span>{p.name}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
