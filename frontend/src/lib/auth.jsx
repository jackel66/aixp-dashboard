// Auth context. GET /auth/session once at mount and again after login, logout or any 401.
// can(key) answers from the permission keys the server computed for this user.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onUnauthorized } from './api.js';
import { clearQueryCache } from './query.js';
import { useLiveRefresh } from './live.jsx';

const NO_SCOPE = { all: false, lob_cg: [] };
const EMPTY = { loading: true, authenticated: false, user: null, permissions: [], roles: [], scope: NO_SCOPE, ad: { enabled: false, domain: '' }, error: '' };
const AuthContext = createContext({ ...EMPTY, can: () => false, scopeLabel: () => '', refresh: async () => {}, logout: async () => {} });

export function scopeLabel(scope) {
  if (!scope) return 'No data scope';
  if (scope.all) return 'All lines of business';
  const n = (scope.lob_cg || []).length;
  if (!n) return 'No data scope';
  return n + (n === 1 ? ' line of business: ' : ' lines of business: ') + scope.lob_cg.join(', ');
}

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
        scope: s.authenticated && s.scope ? { all: !!s.scope.all, lob_cg: s.scope.lob_cg || [] } : (s.authenticated ? { all: true, lob_cg: [] } : NO_SCOPE),
        ad: s.ad || { enabled: false, domain: '' },
        error: ''
      });
      // A different sign-in state or scope must never see another scope's cached figures.
      clearQueryCache();
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
    scopeLabel: () => scopeLabel(state.scope),
    refresh,
    logout
  }), [state, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

// Mounted inside LiveProvider (the auth context sits above it). A grant or role change may alter
// this user's scope, so re-read the session; refresh clears the query cache.
export function AccessWatcher() {
  const { refresh } = useAuth();
  useLiveRefresh(['access.changed'], () => { refresh(); });
  return null;
}
