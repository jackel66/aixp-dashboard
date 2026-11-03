import React from 'react';
import { useTheme } from '../lib/theme.jsx';

const ORDER = ['system', 'light', 'dark'];
const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON = {
  system: <path d="M2 4h12v7H2z M6 14h4 M8 11v3" />,
  light: <g><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5 M8 13v1.5 M1.5 8H3 M13 8h1.5 M3.4 3.4l1 1 M11.6 11.6l1 1 M3.4 12.6l1-1 M11.6 4.4l1-1" /></g>,
  dark: <path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z" />
};

// Cycles system, light, dark. The label states the current mode; the theme switch is not animated.
export default function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
  return (
    <button type="button" onClick={() => setMode(next)} className="nav-link" aria-label={'Theme: ' + LABEL[mode] + '. Switch to ' + LABEL[next]} title={'Theme: ' + LABEL[mode]}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[mode]}</svg>
      <span className="t-small hidden lg:inline">{LABEL[mode]}</span>
    </button>
  );
}
