import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { syncChartTheme } from '../components/charts/chartSetup.js';

// Theme mode: system | light | dark. The mode is stored in localStorage (aixp.theme). An explicit
// choice sets data-theme on <html>; system removes it so the media query decides.
const KEY = 'aixp.theme';
const ThemeContext = createContext({ mode: 'system', resolved: 'light', setMode: () => {}, version: 0 });

function readMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}
function systemDark() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(readMode);
  const [sys, setSys] = useState(systemDark);
  const [version, setVersion] = useState(0);
  const resolved = mode === 'system' ? (sys ? 'dark' : 'light') : mode;

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSys(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    syncChartTheme();
    setVersion((v) => v + 1);
  }, [mode, sys]);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => { syncChartTheme(); setVersion((v) => v + 1); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const setMode = useCallback((m) => {
    const next = m === 'light' || m === 'dark' ? m : 'system';
    try { if (next === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
    setModeState(next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode, version }), [mode, resolved, setMode, version]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
