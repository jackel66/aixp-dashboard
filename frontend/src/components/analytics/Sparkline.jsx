import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import ChartBoundary from '../charts/ChartBoundary.jsx';
import { BRAND } from '../charts/chartSetup.js';
import { useChartNudge, sig } from '../charts/useChartNudge.js';

const OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  layout: { padding: { top: 4, bottom: 2, left: 2, right: 2 } },
  scales: { x: { display: false }, y: { display: false } },
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  events: []
};

// 40 px line with a light fill, no axes. values: array of numbers, oldest first.
export default function Sparkline({ values, ready = true }) {
  const labels = useMemo(() => values.map((_, i) => String(i)), [values]);
  const data = useMemo(() => ({
    labels,
    datasets: [{
      data: values, borderColor: BRAND.sky, backgroundColor: 'rgba(36,177,230,0.16)', fill: true,
      borderWidth: 1.5, tension: 0.3, pointRadius: 0, pointHoverRadius: 0
    }]
  }), [labels, values]);
  const ref = useChartNudge();
  if (!ready || values.length < 2) return null;
  return (
    <div className="an-tile-spark" aria-hidden="true">
      <ChartBoundary><Line key={sig(labels, 1)} ref={ref} data={data} options={OPTIONS} /></ChartBoundary>
    </div>
  );
}
