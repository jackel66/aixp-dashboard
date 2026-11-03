// useQuery(path, params, { events }) - module cache keyed by the sorted URL, stale-while-revalidate
// for 30 s, in-flight dedupe, last good data kept on error, SSE invalidation (debounced 150 ms)
// and a full clear on fixture.generated.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useLiveRefresh } from './live.jsx';

const TTL = 30000;
const cache = new Map(); // key -> { data, at, error, promise }
const subs = new Map(); // key -> Set(fn)
const DEFAULT_EVENTS = ['dataset.*', 'settings.changed', 'fixture.generated'];

export function buildUrl(path, params) {
  const entries = [];
  Object.keys(params || {}).sort().forEach((k) => {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach((x) => entries.push([k, x]));
    else entries.push([k, v]);
  });
  const qs = entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return qs ? path + '?' + qs : path;
}

function notify(key) {
  const set = subs.get(key);
  if (set) set.forEach((fn) => fn());
}

function load(key, force) {
  let e = cache.get(key);
  if (!e) { e = { data: undefined, at: 0, error: null, promise: null }; cache.set(key, e); }
  if (e.promise) return e.promise;
  if (!force && e.data !== undefined && Date.now() - e.at < TTL) return Promise.resolve(e.data);
  e.promise = api.get(key).then((data) => {
    e.data = data; e.at = Date.now(); e.error = null; e.promise = null; notify(key); return data;
  }).catch((err) => {
    e.error = err; e.promise = null; notify(key);
  });
  notify(key);
  return e.promise;
}

let timer = null;
function invalidateAll(clear) {
  if (clear) cache.clear();
  else cache.forEach((e) => { e.at = 0; });
  clearTimeout(timer);
  timer = setTimeout(() => { subs.forEach((set, key) => { if (set.size) load(key, true); }); }, 150);
}
export function clearQueryCache() { invalidateAll(true); }

export function useQuery(path, params, opts = {}) {
  const key = path ? buildUrl(path, params) : null;
  const [, tick] = useState(0);
  const rerender = useCallback(() => tick((n) => n + 1), []);
  const enabled = opts.enabled !== false && !!key;

  useEffect(() => {
    if (!enabled) return undefined;
    let set = subs.get(key);
    if (!set) { set = new Set(); subs.set(key, set); }
    set.add(rerender);
    load(key, false);
    return () => { set.delete(rerender); };
  }, [key, enabled, rerender]);

  const evRef = useRef(opts.events || DEFAULT_EVENTS);
  useLiveRefresh(evRef.current, (ev) => { invalidateAll(ev.type === 'fixture.generated'); });

  const e = key ? cache.get(key) : null;
  const reload = useCallback(() => { if (key) load(key, true); }, [key]);
  return {
    data: e ? e.data : undefined,
    error: e ? e.error : null,
    loading: enabled && (!e || (e.data === undefined && !e.error)),
    refreshing: !!(e && e.promise && e.data !== undefined),
    reload
  };
}
