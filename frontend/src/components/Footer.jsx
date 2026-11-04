import React from 'react';
import { Link } from 'react-router-dom';
import { CAVEAT } from '../lib/platforms.js';
import { useAuth } from '../lib/auth.jsx';

export default function Footer() {
  const { can } = useAuth();
  return (
    <footer className="border-t border-line bg-bg-1 mt-auto">
      <div style={{ paddingTop: 20, paddingBottom: 20 }} className="page flex flex-col gap-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <span className="flex items-center gap-2"><span className="font-display" style={{ fontWeight: 700 }}>AIxP</span><span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 9999, background: 'var(--accent)' }} /></span>
          <nav aria-label="Footer" className="flex items-center gap-4 t-small">
            <Link to="/overview" className="text-muted">Overview</Link>
            <Link to="/data-quality" className="text-muted">Data quality</Link>
            {(can('settings.manage') || can('data.manage') || can('access.manage')) && <Link to="/settings" className="text-muted">Settings</Link>}
            <Link to="/diagnostics" className="text-muted">Diagnostics</Link>
          </nav>
        </div>
        <p className="t-small text-muted m-0" style={{ maxWidth: 820 }}>{CAVEAT}</p>
      </div>
    </footer>
  );
}
