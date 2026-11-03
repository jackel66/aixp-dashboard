import { useMemo } from 'react';
import { useTheme } from './theme.jsx';
import { PLATFORM_IDS } from './platforms.js';

export function cssVar(name, fallback = '') {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Resolved hex values for canvas drawing. Recomputed when the theme changes.
export function useThemeColors() {
  const { version } = useTheme();
  return useMemo(() => {
    const platform = {};
    PLATFORM_IDS.forEach((id) => { platform[id] = cssVar('--p-' + id, '#888888'); });
    return {
      platform,
      ink: cssVar('--ink', '#0b0b0b'),
      muted: cssVar('--muted', '#52514e'),
      faint: cssVar('--faint', '#77756f'),
      line: cssVar('--line', '#e1dfd9'),
      surface: cssVar('--bg-1', '#fcfcfb'),
      accent: cssVar('--accent', '#25324f')
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
}

export function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return hex;
  return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
}
