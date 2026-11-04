// Auth context. GET /auth/session once at mount and again after login, logout or any 401.
// can(key) answers from the permission keys the server computed for this user.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onUnauthorized } from './api.js';
import { clearQueryCache } from './query.js';

const EMPTY = { loading: true, authenticated: false, user: null, permissions: [], roles: [], ad: { enabled: false, domain: '' }, error: '' };
const AuthContext = createContext({ ...EMPTY, can: () => false, refresh: async () => {}, logout: async () => {} });

export function AuthProvider({ children }) {
  const [state, setState] = useState(EMPTY);
  const signedIn = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/auth/session');
      signedIn.current = !!s.authenticated;
      setState({
        loading: false,
        authenticated: !!s.authenticated,
        user: s.authenticated ? s.user : null,
        permissions: s.authenticated ? (s.permissions || []) : [],
        roles: s.authenticated ? (s.roles || []) : [],
        ad: s.ad || { enabled: false, domain: '' },
        error: ''
      });
      if (!s.authenticated) clearQueryCache();
    } catch (e) {
      signedIn.current = false;
      setState((o) => ({ ...EMPTY, loading: false, ad: o.ad, error: e.message || 'Could not reach the server' }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => onUnauthorized(() => { if (signedIn.current) refresh(); }), [refresh]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout', {}); } catch { /* the session may already be gone */ }
    await refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    ...state,
    can: (key) => state.permissions.includes(key),
    refresh,
    logout
  }), [state, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
