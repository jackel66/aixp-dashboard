import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useLive } from '../lib/live.jsx';
import { api, isMock } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Dialog from './ui/Dialog.jsx';
import Button from './ui/Button.jsx';
import Chip from './ui/Chip.jsx';
import { useToast } from './ui/Toast.jsx';
import Tooltip from './ui/Tooltip.jsx';
import { Field } from './settings/shared.jsx';

function ChangePasswordDialog({ onClose, onDone }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const lenOk = pw.length >= 10 && pw.length <= 128;
  const problem = !cur ? 'Enter your current password.' : !lenOk ? 'The new password must be 10 to 128 characters.' : pw !== again ? 'The two new passwords do not match.' : '';
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/change-password', { current_password: cur, new_password: pw });
      toast.success('Password changed');
      onDone();
    } catch (e) {
      setErr(e.message || 'Could not change the password');
    } finally { setBusy(false); }
  };
  return (
    <Dialog open title="Change password" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!!problem || busy}>{busy ? 'Saving' : 'Change password'}</Button></>}>
      <form onSubmit={submit}>
        <Field label="Current password" htmlFor="cp-cur"><input id="cp-cur" type="password" autoFocus autoComplete="current-password" className="input w-full" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password" htmlFor="cp-new" hint="10 to 128 characters."><input id="cp-new" type="password" autoComplete="new-password" className="input w-full" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="New password again" htmlFor="cp-again"><input id="cp-again" type="password" autoComplete="new-password" className="input w-full" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        {err ? <p role="alert" className="m-0 text-sm" style={{ color: 'var(--fail)' }}>{err}</p> : null}
        <button type="submit" className="sr-only" tabIndex={-1}>Change password</button>
      </form>
    </Dialog>
  );
}

// Neutral chip for a user who sees only some lines of business. Hidden for scope.all.
function ScopeChip() {
  const { scope, authenticated } = useAuth();
  if (!authenticated || !scope || scope.all) return null;
  const vals = scope.lob_cg || [];
  const short = !vals.length ? 'none' : vals.length === 1 ? vals[0] : vals.length + ' LOBs';
  const tip = !vals.length ? 'No data scope. Ask an administrator to grant a line of business.' : (vals.length === 1 ? 'Line of business: ' : 'Lines of business: ') + vals.join(', ');
  return (
    <Tooltip text={tip} side="bottom">
      <span tabIndex={0} className="chip chip-outline" style={{ whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} aria-label={'Data scope: ' + tip} data-testid="scope-chip">
        <span className="hidden sm:inline">Scope: {short}</span><span className="sm:hidden">Scope</span>
      </span>
    </Tooltip>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!user) return null;
  const name = user.display_name || user.username;
  const local = user.source === 'local';
  return (
    <div ref={box} className="relative">
      <button type="button" className="nav-link bg-transparent border-0 cursor-pointer" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ font: 'inherit' }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.7" /><path d="M2.5 14a5.5 5.5 0 0111 0" /></svg>
        <span className="t-small hidden md:inline">{name}</span>
      </button>
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 z-[60] bg-bg-1 border border-line rounded-xl" style={{ top: '100%', marginTop: 6, minWidth: 240, padding: 8, boxShadow: 'var(--shadow-2)' }}>
          <div style={{ padding: '6px 8px 10px' }}>
            <div style={{ fontWeight: 600 }}>{name}</div>
            <div className="t-small text-muted" style={{ wordBreak: 'break-word' }}>{user.username}{user.email ? ' - ' + user.email : ''}</div>
            <div style={{ marginTop: 6 }}><Chip tone={local ? 'gray' : 'accent'}>{local ? 'Local' : 'Domain'}</Chip></div>
          </div>
          {local && <button type="button" role="menuitem" className="side-link w-full bg-transparent border-0 cursor-pointer" style={{ font: 'inherit' }} onClick={() => { setOpen(false); setPwOpen(true); }}>Change password</button>}
          <button type="button" role="menuitem" className="side-link w-full bg-transparent border-0 cursor-pointer" style={{ font: 'inherit' }} onClick={() => { setOpen(false); logout(); }}>Sign out</button>
        </div>
      )}
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} onDone={() => setPwOpen(false)} />}
    </div>
  );
}

// Slim top header: wordmark, live state, theme and Settings. Section navigation is the
// left Sidebar.
export default function Nav() {
  const { connected } = useLive();
  const { can } = useAuth();
  const showSettings = can('settings.manage') || can('data.manage') || can('access.manage');
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
        <NavLink to="/help" className="nav-link" aria-label="Help">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M6.2 6.3a1.9 1.9 0 013.6.7c0 1.2-1.8 1.5-1.8 2.6 M8 11.6v.4" /></svg>
          <span className="t-small hidden lg:inline">Help</span>
        </NavLink>
        {showSettings && <NavLink to="/settings" className="nav-link" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M3.4 12.6l1.4-1.4 M11.2 4.8l1.4-1.4" />
          </svg>
          <span className="t-small hidden lg:inline">Settings</span>
        </NavLink>}
        <ScopeChip />
        <AccountMenu />
      </nav>
    </header>
  );
}
