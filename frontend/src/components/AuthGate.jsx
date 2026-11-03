// Shared-password gate. When the server has APP_PASSWORD set, every /api route needs
// a session cookie; this component asks for the password once and then renders the app.
import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function AuthGate({ children }) {
  const [state, setState] = useState({ loading: true, required: false, authenticated: false });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function check() {
    try {
      const s = await api.get('/auth/session');
      setState({ loading: false, required: !!s.required, authenticated: !!s.authenticated });
    } catch (e) {
      setState({ loading: false, required: false, authenticated: false });
      setError(e.message || 'Could not reach the server');
    }
  }

  useEffect(() => { check(); }, []);

  async function submit(ev) {
    ev.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', { password });
      setPassword('');
      await check();
    } catch (e) {
      setError(e.status === 401 ? 'Wrong password' : (e.message || 'Login failed'));
    } finally {
      setBusy(false);
    }
  }

  if (state.loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted text-sm" role="status">Loading</div>;
  }
  if (!state.required || state.authenticated) return children;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-0 px-4">
      <form onSubmit={submit} className="card w-full" style={{ maxWidth: 380, padding: 28 }}>
        <div className="t-h2 flex items-center gap-2"><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 9999, background: 'var(--accent)' }} />AIxP</div>
        <h1 className="t-h1 mt-4">Sign in</h1>
        <p className="text-sm text-muted mt-1 mb-5">Enter the team password to continue.</p>
        <label className="block t-small font-semibold text-muted mb-1" htmlFor="pw">Password</label>
        <input id="pw" type="password" autoFocus autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} className="input w-full" style={{ height: 36 }} />
        {error ? <div className="text-sm mt-2 flex items-center gap-1" role="alert"><span aria-hidden="true" style={{ color: 'var(--fail)' }}>!</span> {error}</div> : null}
        <button type="submit" disabled={busy || !password}
          className="mt-5 w-full rounded-lg bg-accent text-on-accent disabled:opacity-50 font-semibold h-9 text-sm border-0 cursor-pointer">
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
