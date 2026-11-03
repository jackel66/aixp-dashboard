// Server-sent events bridge. One EventSource per tab; pages subscribe by event type.
// Event payload shape (see docs/CONTRACT.md): { type, id, at, ...extra }
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

const LiveContext = createContext({ subscribe: () => () => {}, connected: false, lastEvent: null });

// Cache buster. The bundle knows its own build id; the server sends the id of the bundle it
// serves on every event-stream connect. A mismatch means a new build was deployed (or a CDN
// handed out a stale shell), so reload once with a fresh query string that no cache has seen.
// sessionStorage keeps a loop impossible: one reload per server build id per tab.
const OWN_BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : null;
function checkBuild(serverId) {
  if (!serverId || !OWN_BUILD || serverId === OWN_BUILD) return;
  let done = null;
  try { done = sessionStorage.getItem('aixp.reloadedFor'); } catch { done = null; }
  if (done === serverId) return;
  try { sessionStorage.setItem('aixp.reloadedFor', serverId); } catch { /* storage blocked */ }
  const url = new URL(window.location.href);
  url.searchParams.set('v', serverId);
  window.location.replace(url.toString());
}

export function LiveProvider({ children }) {
  const listeners = useRef(new Set());
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);

  useEffect(() => {
    let es;
    let retry = 1000;
    let closed = false;
    function open() {
      es = new EventSource('/api/events');
      es.onopen = () => { setConnected(true); retry = 1000; };
      es.onmessage = (m) => {
        let ev = null;
        try { ev = JSON.parse(m.data); } catch { return; }
        if (!ev || ev.type === 'ping') return;
        if (ev.type === 'hello') { checkBuild(ev.buildId); return; }
        setLastEvent(ev);
        listeners.current.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } });
      };
      es.onerror = () => {
        setConnected(false);
        es.close();
        if (!closed) setTimeout(open, retry = Math.min(retry * 2, 15000));
      };
    }
    open();
    return () => { closed = true; if (es) es.close(); };
  }, []);

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  return <LiveContext.Provider value={{ subscribe, connected, lastEvent }}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}

// useLiveRefresh(['opportunity.*', 'snapshot.created'], reload) calls reload(ev) whenever a matching event lands.
// A pattern 'x.*' matches every type starting with 'x.'; '*' matches everything.
export function useLiveRefresh(patterns, handler) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  const key = JSON.stringify(patterns);
  useEffect(() => {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    return subscribe((ev) => {
      const hit = list.some((p) => p === '*' || p === ev.type || (p.endsWith('.*') && ev.type.startsWith(p.slice(0, -1))));
      if (hit) ref.current(ev);
    });
  }, [subscribe, key]);
}
