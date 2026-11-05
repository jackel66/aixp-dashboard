// Thin fetch wrapper. Every call returns parsed JSON or throws an Error with .status and .body.
// With VITE_MOCK=1 a GET is served from src/mock/*.json by path, so pages run without a backend.
const MOCK = import.meta.env.VITE_MOCK === '1';
const mockFiles = MOCK ? import.meta.glob('../mock/*.json') : {};

function mockName(path, params) {
  const p = path.replace(/^\/+/, '');
  if (p === 'trend') return 'trend-' + (params.get('grain') || 'week');
  const m = p.match(/^platforms\/([^/]+)$/);
  if (m) return 'platform-' + m[1];
  if (/^access\/roles\/\d+\/assignments$/.test(p)) return 'access-roles-assignments';
  return p.replace(/\//g, '-');
}

// Mock sign-in state lives in localStorage so the login page can be exercised without a backend:
// logout sets the flag, a login with any password except "bad" clears it.
const MOCK_OUT = 'aixp.mock.signedout';
function mockOut(v) {
  try { if (v === undefined) return localStorage.getItem(MOCK_OUT) === '1'; if (v) localStorage.setItem(MOCK_OUT, '1'); else localStorage.removeItem(MOCK_OUT); } catch { /* storage blocked */ }
  return false;
}
// Mock scope for exercising scoped views: localStorage aixp.mock.scope = "none" or "one".
// "none" signs in without data.all and answers every data read 403 no_scope.
function mockScopeMode() {
  try { return localStorage.getItem('aixp.mock.scope') || ''; } catch { return ''; }
}
function mockScope(s) {
  const mode = mockScopeMode();
  if (!mode) return s;
  const perms = (s.permissions || []).filter((k) => k !== 'data.all' && k !== 'access.manage' && k !== 'settings.manage' && k !== 'data.manage');
  return { ...s, permissions: perms, scope: { all: false, lob_cg: mode === 'one' ? ['Capital Markets'] : [] } };
}
const NO_SCOPE_PATHS = /^(summary|trend|organization|users|models|platforms|reports|verification|datasets)(\/|$)/;
async function mockFile(name) {
  const loader = mockFiles['../mock/' + name + '.json'];
  if (!loader) {
    const err = new Error('No mock for ' + name);
    err.status = 404;
    throw err;
  }
  const mod = await loader();
  return JSON.parse(JSON.stringify(mod.default));
}

async function mockRequest(method, path, body) {
  const [bare, qs] = path.split('?');
  if (bare === '/auth/session') {
    const s = await mockFile('auth-session');
    return mockOut() ? { authenticated: false, ad: s.ad } : mockScope(s);
  }
  if (bare === '/auth/login') {
    if (body && body.password === 'bad') {
      const err = new Error('Wrong username or password');
      err.status = 401;
      err.body = { error: err.message, code: 'bad_credentials' };
      throw err;
    }
    mockOut(false);
    return mockScope(await mockFile('auth-session'));
  }
  if (bare === '/auth/logout') { mockOut(true); return { ok: true }; }
  if (bare === '/health') return { ok: true, buildId: 'mock', mock: true };
  if (method === 'POST' && bare === '/access/directory/test') return mockFile('access-directory-test');
  if (method === 'POST' && bare === '/access/directory/sync') return { users: 2, updated: 2, deactivated: 0, errors: [] };
  if (method !== 'GET') return { ok: true, mock: true };
  if (mockScopeMode() === 'none' && NO_SCOPE_PATHS.test(bare.replace(/^\/+/, ''))) {
    const err = new Error('No data scope is assigned to your account. Ask an administrator to grant a line of business.');
    err.status = 403;
    err.body = { error: err.message, code: 'no_scope' };
    throw err;
  }
  const params = new URLSearchParams(qs || '');
  const name = mockName(bare, params);
  if (name === 'access-directory-search') {
    const all = await mockFile(name);
    const q = (params.get('q') || '').toLowerCase();
    const rows = [];
    (params.get('type') || 'user').split(',').forEach((t) => {
      (all[t] || []).forEach((r) => { if (!q || JSON.stringify(r).toLowerCase().includes(q)) rows.push(r); });
    });
    return { rows };
  }
  return mockFile(name);
}

// Subscribers called when any non-auth call answers 401 (the session ended). The auth context
// subscribes and refreshes, so the login page shows.
const unauthorizedHandlers = new Set();
export function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
}

async function request(method, path, body, opts = {}) {
  if (MOCK) return mockRequest(method, path, body);
  const headers = {};
  if (method !== 'GET') headers['x-aixp-csrf'] = '1';
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, ...opts });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandlers.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    const err = new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const isMock = MOCK;

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  delete: (path, opts) => request('DELETE', path, undefined, opts)
};

export default api;
