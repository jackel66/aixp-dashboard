// Thin fetch wrapper. Every call returns parsed JSON or throws an Error with .status and .body.
// With VITE_MOCK=1 a GET is served from src/mock/*.json by path, so pages run without a backend.
const MOCK = import.meta.env.VITE_MOCK === '1';
const mockFiles = MOCK ? import.meta.glob('../mock/*.json') : {};

function mockName(path, params) {
  const p = path.replace(/^\/+/, '');
  if (p === 'trend') return 'trend-' + (params.get('grain') || 'week');
  const m = p.match(/^platforms\/([^/]+)$/);
  if (m) return 'platform-' + m[1];
  return p.replace(/\//g, '-');
}

async function mockRequest(method, path) {
  const [bare, qs] = path.split('?');
  if (bare === '/auth/session') return { required: false, authenticated: true };
  if (bare === '/health') return { ok: true, buildId: 'mock', mock: true };
  if (method !== 'GET') return { ok: true, mock: true };
  const name = mockName(bare, new URLSearchParams(qs || ''));
  const loader = mockFiles['../mock/' + name + '.json'];
  if (!loader) {
    const err = new Error('No mock for ' + path);
    err.status = 404;
    throw err;
  }
  const mod = await loader();
  return JSON.parse(JSON.stringify(mod.default));
}

async function request(method, path, body, opts = {}) {
  if (MOCK) return mockRequest(method, path);
  const headers = {};
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
