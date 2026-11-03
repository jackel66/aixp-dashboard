import React, { useMemo } from 'react';
import TrendChart from '../charts/TrendChart.jsx';
import { useThemeColors } from '../../lib/color.js';
import { money, count, pct } from '../../lib/format.js';

// Fixed categorical order from the dataviz default palette (light, dark). Used only for series
// that are not platforms; platform series take the platform identity colour.
const CAT = [
  ['#2a78d6', '#3987e5'], ['#eb6834', '#d95926'], ['#1baf7a', '#199e70'], ['#eda100', '#c98500'],
  ['#e87ba4', '#d55181'], ['#008300', '#008300'], ['#6250d6', '#9085e9'], ['#e34948', '#e66767']
];
const FORMATS = { count, pct: (v) => pct(v, 0), money };
const FORMAT_BY_ID = {
  users_new: 'count', users_multi_platform: 'count', models_adoption: 'count', platforms_seat_utilisation: 'pct'
};
const AXIS_BY_ID = {
  users_new: 'New users', users_multi_platform: 'Users', models_adoption: 'Active users', platforms_seat_utilisation: 'Seat utilisation'
};

function isDark(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  return (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) < 90;
}

export default function ReportChart({ reportId, chart, title }) {
  const colors = useThemeColors();
  const dark = isDark(colors.surface);
  const series = useMemo(() => {
    const multi = chart.series.length > 1;
    return chart.series.map((s, i) => {
      const id = 's' + i;
      if (s.platform) return { id, platform: s.platform, label: s.label, data: s.data };
      if (!multi) return { id, token: 'accent', label: s.label, data: s.data };
      const pair = CAT[i % CAT.length];
      return { id, color: pair[dark ? 1 : 0], label: s.label, data: s.data };
    });
  }, [chart, dark]);
  const fmtKey = FORMAT_BY_ID[reportId] || 'money';
  const stacked = chart.type === 'stacked';
  return (
    <TrendChart
      type={chart.type === 'line' ? 'line' : 'bar'} stacked={stacked} labels={chart.labels} series={series}
      valueFormat={FORMATS[fmtKey]} axisTitle={AXIS_BY_ID[reportId]} total={stacked} height={260}
      ariaLabel={(chart.type === 'line' ? 'Line chart: ' : stacked ? 'Stacked bar chart: ' : 'Bar chart: ') + title} />
  );
}
