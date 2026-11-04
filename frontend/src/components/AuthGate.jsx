// Sign-in page. Wraps the app in the auth context and shows the login card until the server
// reports a signed-in user. The server's error text is shown as it comes.
import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { AuthProvider, useAuth } from '../lib/auth.jsx';

function LoginPage() {
  const { ad, refresh, error: sessionError } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState([]);
  const [busy, setBusy] = useState(false);

  async function submit(ev) {
    ev.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError('');
    setDetail([]);
    try {
      await api.post('/auth/login', { username: username.trim(), password });
      setPassword('');
      await refresh();
    } catch (e) {
      setError(e.message || 'Sign in failed');
      const d = e.body && e.body.code === 'ad_unreachable' && Array.isArray(e.body.detail) ? e.body.detail : [];
      setDetail(d);
    } finally {
      setBusy(false);
    }
  }

  const shown = error || sessionError;
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-0 px-4">
      <form onSubmit={submit} className="card w-full" style={{ maxWidth: 380, padding: 28 }}>
        <div className="t-h2 flex items-center gap-2"><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 9999, background: 'var(--accent)' }} />AIxP</div>
        <h1 className="t-h1" style={{ marginTop: 16 }}>Sign in</h1>
        <p className="text-sm text-muted" style={{ margin: '4px 0 20px' }}>Use your AIxP account to continue.</p>
        <label className="block t-small font-semibold text-muted" style={{ marginBottom: 4 }} htmlFor="login-user">Username</label>
        <input id="login-user" type="text" autoFocus autoComplete="username" spellCheck={false} autoCapitalize="none" value={username}
          onChange={(e) => setUsername(e.target.value)} className="input w-full" style={{ height: 36 }} />
        <label className="block t-small font-semibold text-muted" style={{ margin: '12px 0 4px' }} htmlFor="login-pw">Password</label>
        <input id="login-pw" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} className="input w-full" style={{ height: 36 }} />
        {shown ? <div className="text-sm flex items-start gap-1" style={{ marginTop: 12 }} role="alert"><span aria-hidden="true" style={{ color: 'var(--fail)' }}>!</span><span>{shown}</span></div> : null}
        {detail.length > 0 && (
          <details className="t-small text-muted" style={{ marginTop: 8 }}>
            <summary className="cursor-pointer">Details</summary>
            <ul className="m-0 mt-1" style={{ paddingLeft: 18 }}>{detail.map((d, i) => <li key={i} style={{ wordBreak: 'break-word' }}>{String(d)}</li>)}</ul>
          </details>
        )}
        <button type="submit" disabled={busy || !username.trim() || !password}
          style={{ marginTop: 20 }} className="w-full rounded-lg bg-accent text-on-accent disabled:opacity-50 font-semibold h-9 text-sm border-0 cursor-pointer">
          {busy ? 'Signing in' : 'Sign in'}
        </button>
        {ad && ad.enabled ? <p className="t-small text-muted" style={{ margin: '16px 0 0' }}>Domain accounts: use name@{ad.domain || 'domain'} or DOMAIN\name</p> : null}
        <p className="t-small text-muted" style={{ margin: '8px 0 0' }}>Password resets are done by an administrator.</p>
      </form>
    </div>
  );
}

function Gate({ children }) {
  const { loading, authenticated } = useAuth();
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted text-sm" role="status">Loading</div>;
  }
  if (!authenticated) return <LoginPage />;
  return children;
}

export default function AuthGate({ children }) {
  return <AuthProvider><Gate>{children}</Gate></AuthProvider>;
}
