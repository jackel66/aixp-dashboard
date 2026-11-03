import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import '../charts/chartSetup.js';
import ChartBoundary from '../charts/ChartBoundary.jsx';
import { useChartNudge, sig } from '../charts/useChartNudge.js';
import { useThemeColors, hexToRgba } from '../../lib/color.js';

const OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  layout: { padding: { top: 4, bottom: 2, left: 2, right: 2 } },
  scales: { x: { display: false }, y: { display: false } },
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  events: [],
  animation: false
};

// Line with a light fill, no axes. values: numbers, oldest first. color: a CSS colour value
// (hex) or a platform id; platform ids resolve through the theme.
export default function Sparkline({ values, color, platform, ready = true, height = 40, className = 'an-tile-spark' }) {
  const colors = useThemeColors();
  const col = color || (platform && colors.platform[platform]) || colors.accent;
  const labels = useMemo(() => values.map((_, i) => String(i)), [values]);
  const data = useMemo(() => ({
    labels,
    datasets: [{
      data: values, borderColor: col, backgroundColor: hexToRgba(col, 0.16), fill: true,
      borderWidth: 1.5, tension: 0.3, pointRadius: 0, pointHoverRadius: 0
    }]
  }), [labels, values, col]);
  const ref = useChartNudge();
  if (!ready || !values || values.length < 2) return null;
  return (
    <div className={className} style={{ height }} aria-hidden="true">
      <ChartBoundary name="sparkline"><Line key={sig(labels, 1)} ref={ref} data={data} options={OPTIONS} /></ChartBoundary>
    </div>
  );
}
export { Sparkline };
