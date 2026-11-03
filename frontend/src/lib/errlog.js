// Captures runtime errors so a user can copy them from /diagnostics. Kept in memory and
// mirrored to sessionStorage (last 30), so a reload after a failure still shows the cause.
const KEY = 'aixp.errors';
const MAX = 30;
let entries = [];
try { entries = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { entries = []; }
const listeners = new Set();

function push(kind, message, stack, extra) {
  const e = { at: new Date().toISOString(), kind, message: String(message || '').slice(0, 600), stack: String(stack || '').slice(0, 2000), extra: extra || null };
  entries = entries.concat([e]).slice(-MAX);
  try { sessionStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage blocked */ }
  listeners.forEach((fn) => { try { fn(entries); } catch { /* listener failed */ } });
}

export function installErrorLog() {
  if (typeof window === 'undefined' || window.__cgErrLog) return;
  window.__cgErrLog = true;
  window.addEventListener('error', (ev) => {
    const err = ev.error;
    push('error', ev.message || (err && err.message), err && err.stack, { file: ev.filename, line: ev.lineno, col: ev.colno });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    push('rejection', r && r.message ? r.message : String(r), r && r.stack);
  });
  const origError = console.error.bind(console);
  console.error = (...args) => {
    try {
      const first = args[0];
      const msg = args.map((a) => (a && a.message) ? a.message : (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a).slice(0, 300); } catch { return String(a); } })())).join(' ');
      push('console.error', msg, first && first.stack);
    } catch { /* never break console */ }
    origError(...args);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    try {
      const msg = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || String(a))).join(' ');
      if (/valueLabels|chart/i.test(msg)) push('console.warn', msg, null);
    } catch { /* never break console */ }
    origWarn(...args);
  };
}

export function logError(kind, err, extra) {
  push(kind, err && err.message ? err.message : String(err), err && err.stack, extra);
}

export function getErrors() { return entries; }
export function clearErrors() { entries = []; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } listeners.forEach((fn) => fn(entries)); }
export function onErrors(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function environmentReport() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const build = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown';
  return {
    build,
    userAgent: nav.userAgent || '',
    language: nav.language || '',
    viewport: typeof window !== 'undefined' ? window.innerWidth + 'x' + window.innerHeight : '',
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
    reducedMotion: (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return null; } })(),
    url: typeof location !== 'undefined' ? location.href : '',
    time: new Date().toISOString()
  };
}
