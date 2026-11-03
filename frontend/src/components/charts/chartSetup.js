import { Chart, CategoryScale, LinearScale, LogarithmicScale, BarElement, ArcElement, LineElement, PointElement, Tooltip, Legend, Animation, Filler } from 'chart.js';

const VL_FONT = '"Open Sans", ui-sans-serif, system-ui, sans-serif';
const VL_INK = '#242b42';

function vlDrawBar(chart, el, text, horizontal, color) {
  const c = chart.ctx;
  const area = chart.chartArea;
  const p = el.getProps(['x', 'y', 'base'], true);
  if (![p.x, p.y, p.base].every(Number.isFinite)) return;
  c.save();
  c.font = '600 10px ' + VL_FONT;
  c.textBaseline = 'middle';
  const w = c.measureText(text).width;
  if (horizontal) {
    const end = Math.max(p.x, p.base);
    const len = Math.abs(p.x - p.base);
    if (area.right - end < 36 && len > w + 8) {
      c.fillStyle = '#ffffff'; c.textAlign = 'right'; c.fillText(text, end - 4, p.y);
    } else {
      c.fillStyle = color; c.textAlign = 'left'; c.fillText(text, end + 4, p.y);
    }
  } else {
    const top = Math.min(p.y, p.base);
    const h = Math.abs(p.base - p.y);
    if (top - 13 < area.top && h > 18) {
      c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.fillText(text, p.x, top + 9);
    } else {
      c.fillStyle = color; c.textAlign = 'center'; c.fillText(text, p.x, top - 8);
    }
  }
  c.restore();
}

function vlBars(chart, opts) {
  const horizontal = chart.options.indexAxis === 'y';
  const valueScale = chart.scales[horizontal ? 'x' : 'y'];
  const stacked = !!(valueScale && valueScale.options && valueScale.options.stacked);
  const fmt = typeof opts.format === 'function' ? opts.format : (v) => String(v);
  const color = opts.color || VL_INK;
  const stacks = {};
  const items = [];
  chart.data.datasets.forEach((ds, di) => {
    if (!chart.isDatasetVisible(di)) return;
    const meta = chart.getDatasetMeta(di);
    if (meta.type !== 'bar') return;
    meta.data.forEach((el, i) => {
      const v = Number(ds.data[i]);
      if (!Number.isFinite(v) || v === 0) return;
      if (stacked) {
        const st = stacks[i] || (stacks[i] = { total: 0, el, di, index: i });
        st.total += v; st.el = el; st.di = di;
      } else {
        items.push({ el, value: v, di, index: i });
      }
    });
  });
  Object.keys(stacks).forEach((k) => {
    const st = stacks[k];
    if (st.total) items.push({ el: st.el, value: st.total, di: st.di, index: st.index });
  });
  items.forEach((it) => {
    const text = fmt(it.value, { chart, datasetIndex: it.di, index: it.index, dataset: chart.data.datasets[it.di] });
    if (text === null || text === undefined || text === '') return;
    vlDrawBar(chart, it.el, String(text), horizontal, color);
  });
}

function vlCenter(chart, opts) {
  if (!opts.center) return;
  const ds = chart.data.datasets[0];
  if (!ds) return;
  let total = 0;
  ds.data.forEach((v, i) => { if (chart.getDataVisibility(i)) total += Number(v) || 0; });
  const a = chart.chartArea;
  const c = chart.ctx;
  c.save();
  c.font = '700 ' + (opts.centerSize || 16) + 'px ' + VL_FONT;
  c.fillStyle = '#070f29';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(total), (a.left + a.right) / 2, (a.top + a.bottom) / 2);
  c.restore();
}

// Inline value-label plugin. Enable per chart: options.plugins.valueLabels = { enabled: true,
// format: (value, ctx) => string, color?, center? (doughnut total), centerSize? }.
const valueLabels = {
  id: 'valueLabels',
  defaults: { enabled: false },
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.enabled) return;
    // A label is decoration: never let a drawing error abort the chart's frame.
    try {
      const type = chart.config.type;
      if (type === 'doughnut' || type === 'pie') vlCenter(chart, opts);
      else if (type === 'bar') vlBars(chart, opts);
    } catch (e) {
      if (!valueLabels._warned) { valueLabels._warned = true; console.warn('[valueLabels] skipped:', e && e.message); }
    }
  }
};

Chart.register(valueLabels);

Chart.register(CategoryScale, LinearScale, LogarithmicScale, BarElement, ArcElement,
  LineElement, PointElement, Tooltip, Legend, Filler);

// Animation engine guard. Chart.js picks an interpolator from the TYPE of a property's starting
// value; for anything that is not a number, boolean or parsable colour there is none, and the
// next frame throws "this._fn is not a function" inside the animator, which runs every chart in
// one loop, so every chart on the page freezes or goes blank (seen on Doug's Chrome 155,
// 2026-10-20). Snap such a property to its end value instead and record what it was.
if (Animation && Animation.prototype && !Animation.prototype.__cgGuarded) {
  const originalTick = Animation.prototype.tick;
  const seen = new Set();
  Animation.prototype.tick = function guardedTick(date) {
    if (typeof this._fn !== 'function') {
      const key = String(this._prop) + ':' + typeof this._from + ':' + typeof this._to;
      if (!seen.has(key)) {
        seen.add(key);
        const show = (v) => { try { return JSON.stringify(v).slice(0, 80); } catch (e) { return String(v); } };
        console.warn('[chart animation] no interpolator for "' + this._prop + '" from ' + typeof this._from + ' ' + show(this._from) + ' to ' + typeof this._to + ' ' + show(this._to) + '; snapped to end value');
      }
      this._target[this._prop] = this._to;
      this._active = false;
      if (typeof this._notify === 'function') this._notify(true);
      return;
    }
    return originalTick.call(this, date);
  };
  Animation.prototype.__cgGuarded = true;
}

Chart.defaults.font.family = '"Open Sans", ui-sans-serif, system-ui, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.color = '#666666';
// Animation is off on purpose: Chart.js runs every animated chart through one shared frame
// loop, and a failure anywhere in that loop leaves every chart frozen or blank until a reload
// (seen on Doug's browser, never in headless QA). Synchronous draws cannot get into that state.
// Mutate, never replace: Chart.js copies ONLY the keys of defaults.animation (delay, duration,
// easing, fn, from, loop, to, type) into each animated property's config. Replacing the object
// with { duration, easing } dropped "type", so colour properties lost their interpolator and the
// first colour change (a hover highlight) threw inside the shared animator and froze every chart.
Chart.defaults.animation.duration = 400;
Chart.defaults.animation.easing = 'easeOutQuart';
Chart.defaults.maintainAspectRatio = false;

export const BRAND = {
  sky: '#24b1e6', steel: '#1f96c3', navy: '#070f29', slate: '#025b76',
  teal: '#00ad8c', orange: '#f9ac33', red: '#ed6363', grey: '#ebebeb'
};

export const RAG_FILL = {
  Green: '#c6e0b4', Amber: '#ffe699', Red: '#f4cccc', Gray: '#d9e1f2', 'Not Updated': '#d9e1f2'
};
export const RAG_LINE = {
  Green: '#7fb069', Amber: '#e0b400', Red: '#ed6363', Gray: '#8a98b8', 'Not Updated': '#8a98b8'
};
export const MOVE_COLOR = {
  Advanced: '#7fb069', Unchanged: '#e0b400', Slipped: '#ed6363', New: '#24b1e6', 'Not Updated': '#8a98b8'
};
export const BAND_COLOR = { strong: '#00ad8c', drifting: '#f9ac33', weak: '#ed6363' };

export function compactMoney(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + n;
}
// Legend for doughnuts: "Name  count (pct%)" instead of arc labels.
export function donutLegend() {
  return {
    position: 'bottom',
    labels: {
      boxWidth: 12, boxHeight: 12,
      generateLabels(chart) {
        const base = Chart.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
        const ds = chart.data.datasets[0];
        const total = ds ? ds.data.reduce((a, v) => a + (Number(v) || 0), 0) : 0;
        return base.map((item) => {
          const n = ds ? Number(ds.data[item.index]) || 0 : 0;
          const pc = total ? Math.round((n / total) * 100) : 0;
          return { ...item, text: item.text + '  ' + n + ' (' + pc + '%)' };
        });
      }
    }
  };
}
export default Chart;
