import React, { useMemo } from 'react';
import { Doughnut } from 'react-chartjs-2';
import './chartSetup.js';
import ChartBoundary from './ChartBoundary.jsx';
import { useChartNudge, sig } from './useChartNudge.js';
import { useThemeColors } from '../../lib/color.js';
import { money, pct } from '../../lib/format.js';

// Share of a USD total by platform. items: [{ id, label, value }]. The legend is HTML so every
// share is readable without colour or hover.
export default function ShareDonut({ items, height = 220, ariaLabel, centerLabel = money }) {
  const colors = useThemeColors();
  const ref = useChartNudge();
  const total = items.reduce((a, i) => a + (Number(i.value) || 0), 0);
  const data = useMemo(() => ({
    labels: items.map((i) => i.label),
    datasets: [{
      data: items.map((i) => i.value),
      backgroundColor: items.map((i) => colors.platform[i.id] || colors.accent),
      borderColor: colors.surface, borderWidth: 2, hoverBorderWidth: 2
    }]
  }), [items, colors]);
  const options = useMemo(() => ({
    responsive: true, maintainAspectRatio: false, cutout: '66%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => ' ' + c.label + ': ' + money(c.parsed) + ' (' + pct(total ? (c.parsed / total) * 100 : 0, 0) + ')' } },
      valueLabels: { enabled: true, center: true, centerFormat: centerLabel, centerSize: 18 }
    }
  }), [total, centerLabel]);

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div role="img" aria-label={ariaLabel} style={{ height, width: height, position: 'relative', flex: '0 0 auto' }}>
        <ChartBoundary name="share" resetKey={sig(items.map((i) => i.id))}>
          <Doughnut key={sig(items.map((i) => i.id))} ref={ref} data={data} options={options} />
        </ChartBoundary>
      </div>
      <ul className="list-none p-0 m-0 flex-1" style={{ minWidth: 160 }}>
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 py-1">
            <span className="flex items-center gap-2">
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: colors.platform[i.id], display: 'inline-block' }} />
              {i.label}
            </span>
            <span className="num text-muted">{money(i.value)} ({pct(total ? (i.value / total) * 100 : 0, 0)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
export { ShareDonut };
