import React, { useMemo, useState } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import './chartSetup.js';
import ChartBoundary from './ChartBoundary.jsx';
import { useChartNudge, sig } from './useChartNudge.js';
import { useThemeColors } from '../../lib/color.js';
import { money } from '../../lib/format.js';

// Time series by platform. series: [{ id, label, platform?, color?, data: number[] }].
// platform picks the identity colour; color overrides for non-platform series.
// type 'bar' (optionally stacked) or 'line'. A legend is always shown for 2 or more series, and a
// table view is one click away so no value depends on hover or colour.
export function bucketsToSeries(buckets, platformIds, measure = 'usd') {
  return platformIds.map((id) => ({
    id,
    platform: id,
    label: null,
    data: buckets.map((b) => {
      const c = b.platforms && b.platforms[id];
      if (!c) return 0;
      return measure === 'users' ? c.active_users : c.usd;
    })
  }));
}

export default function TrendChart({
  labels, series, type = 'bar', stacked = false, height = 280, ariaLabel, valueFormat = money,
  axisTitle, nameOf = (s) => s.label || s.id, total = false
}) {
  const colors = useThemeColors();
  const ref = useChartNudge();
  const [table, setTable] = useState(false);
  const colorOf = (s) => s.color || (s.token && colors[s.token]) || (s.platform && colors.platform[s.platform]) || colors.accent;

  const data = useMemo(() => ({
    labels,
    datasets: series.map((s) => {
      const col = colorOf(s);
      const base = { label: nameOf(s), data: s.data };
      if (type === 'line') {
        return { ...base, borderColor: col, backgroundColor: col, borderWidth: 2, tension: 0.25, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: colors.surface, fill: false };
      }
      return { ...base, backgroundColor: col, borderColor: colors.surface, borderWidth: stacked ? 2 : 0, borderRadius: 4, borderSkipped: false, maxBarThickness: 28 };
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [labels, series, type, stacked, colors]);

  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4 } },
    scales: {
      x: { stacked, grid: { display: false }, border: { color: colors.line }, ticks: { color: colors.faint, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
      y: {
        stacked, beginAtZero: true, border: { display: false }, grid: { color: colors.line },
        ticks: { color: colors.faint, callback: (v) => valueFormat(v), maxTicksLimit: 6 },
        title: axisTitle ? { display: true, text: axisTitle, color: colors.muted } : { display: false }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c) => ' ' + c.dataset.label + ': ' + valueFormat(c.parsed.y),
          footer: (items) => (total && items.length > 1 ? 'Total: ' + valueFormat(items.reduce((a, i) => a + (i.parsed.y || 0), 0)) : '')
        }
      }
    }
  }), [colors, stacked, axisTitle, valueFormat, total]);

  const remount = sig(labels, series.length) + type + (stacked ? 's' : '');
  const Cmp = type === 'line' ? Line : Bar;
  const showLegend = series.length >= 2;

  return (
    <div>
      {showLegend && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 list-none p-0 m-0 mb-2" aria-label="Legend">
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-2 t-small text-muted">
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: colorOf(s), display: 'inline-block' }} />
              {nameOf(s)}
            </li>
          ))}
        </ul>
      )}
      {table ? (
        <div style={{ height, overflow: 'auto' }}>
          <table className="tbl compact">
            <thead>
              <tr><th>Period</th>{series.map((s) => <th key={s.id} className="r">{nameOf(s)}</th>)}</tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l + i}><td>{l}</td>{series.map((s) => <td key={s.id} className="r num">{valueFormat(s.data[i])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="img" aria-label={ariaLabel} style={{ height, position: 'relative' }}>
          <ChartBoundary name="trend" resetKey={remount}>
            <Cmp key={remount} ref={ref} data={data} options={options} />
          </ChartBoundary>
        </div>
      )}
      <div className="flex justify-end mt-1">
        <button type="button" className="t-small text-muted underline bg-transparent border-0 cursor-pointer" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>
    </div>
  );
}
export { TrendChart };
