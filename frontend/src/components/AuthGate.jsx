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
    return <div className="min-h-screen flex items-center justify-center text-t3-grey text-sm">Loading</div>;
  }
  if (!state.required || state.authenticated) return children;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-t3-navy to-t3-slate px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-xl shadow-xl p-8">
        <div className="flex items-center gap-3 mb-1">
          <img src="/fsg-logo.png" alt="FSG" width="48" height="48" className="block rounded-full" style={{ width: 48, height: 48 }} />
          <div>
            <div className="font-extrabold text-t3-navy tracking-tight text-lg leading-tight">TRACE3</div>
            <div className="text-t3-grey text-sm leading-tight">Financial Services Group</div>
          </div>
        </div>
        <h1 className="text-xl font-bold text-t3-ink mt-4">FSG deal tracker</h1>
        <p className="text-sm text-t3-grey mt-1 mb-5">Enter the team password to continue.</p>
        <label className="block text-xs font-semibold text-t3-grey mb-1" htmlFor="pw">Password</label>
        <input
          id="pw"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-t3-smoke rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-t3-sky"
        />
        {error ? <div className="text-sm text-t3-red mt-2">{error}</div> : null}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 w-full rounded-full bg-t3-sky hover:bg-t3-steel disabled:opacity-50 text-white font-semibold py-2 text-sm transition-colors"
        >
          {busy ? 'Signing in' : 'Sign in'}
        </button>
        <p className="text-xs text-t3-grey mt-5">Internal tool. Data is customer confidential.</p>
      </form>
    </div>
  );
}
