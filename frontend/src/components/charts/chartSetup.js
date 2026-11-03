import { Chart, CategoryScale, LinearScale, LogarithmicScale, BarElement, ArcElement, LineElement, PointElement, Tooltip, Legend, Animation, Filler } from 'chart.js';
import { money } from '../../lib/format.js';

// Theme values the valueLabels plugin reads at draw time. syncChartTheme() refreshes them.
const vl = { font: '"Inter", ui-sans-serif, system-ui, sans-serif', ink: '#0b0b0b', onFill: '#ffffff' };

function vlDrawBar(chart, el, text, horizontal, color) {
  const c = chart.ctx;
  const area = chart.chartArea;
  const p = el.getProps(['x', 'y', 'base'], true);
  if (![p.x, p.y, p.base].every(Number.isFinite)) return;
  c.save();
  c.font = '600 10px ' + vl.font;
  c.textBaseline = 'middle';
  const w = c.measureText(text).width;
  if (horizontal) {
    const end = Math.max(p.x, p.base);
    const len = Math.abs(p.x - p.base);
    if (area.right - end < 36 && len > w + 8) {
      c.fillStyle = vl.onFill; c.textAlign = 'right'; c.fillText(text, end - 4, p.y);
    } else {
      c.fillStyle = color; c.textAlign = 'left'; c.fillText(text, end + 4, p.y);
    }
  } else {
    const top = Math.min(p.y, p.base);
    const h = Math.abs(p.base - p.y);
    if (top - 13 < area.top && h > 18) {
      c.fillStyle = vl.onFill; c.textAlign = 'center'; c.fillText(text, p.x, top + 9);
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
  const color = opts.color || vl.ink;
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
  const text = typeof opts.centerFormat === 'function' ? opts.centerFormat(total) : String(total);
  c.save();
  c.font = '700 ' + (opts.centerSize || 16) + 'px "Sora", ' + vl.font;
  c.fillStyle = vl.ink;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, (a.left + a.right) / 2, (a.top + a.bottom) / 2);
  c.restore();
}

// Inline value-label plugin. Enable per chart: options.plugins.valueLabels = { enabled: true,
// format: (value, ctx) => string, color?, center? (doughnut total), centerFormat?, centerSize? }.
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
// one loop, so every chart on the page freezes or goes blank. Snap such a property to its end
// value instead and record what it was.
if (Animation && Animation.prototype && !Animation.prototype.__aixpGuarded) {
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
  Animation.prototype.__aixpGuarded = true;
}

Chart.defaults.font.family = vl.font;
Chart.defaults.font.size = 12;
// Mutate, never replace: Chart.js copies ONLY the keys of defaults.animation into each animated
// property's config. Replacing the object drops "type", colour properties lose their interpolator
// and the first colour change (a hover highlight) throws inside the shared animator.
Chart.defaults.animation.duration = 400;
Chart.defaults.animation.easing = 'easeOutQuart';
Chart.defaults.maintainAspectRatio = false;

function cssv(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Read the live CSS tokens into Chart.js defaults. Called by ThemeProvider on mount and on every
// theme change. Duration drops to 0 under reduced motion (a mutation, not a new object).
export function syncChartTheme() {
  const muted = cssv('--muted', '#52514e');
  const line = cssv('--line', '#e1dfd9');
  const surface = cssv('--bg-1', '#fcfcfb');
  const ink = cssv('--ink', '#0b0b0b');
  vl.ink = ink;
  vl.onFill = '#ffffff';
  Chart.defaults.color = muted;
  Chart.defaults.borderColor = line;
  Chart.defaults.font.family = vl.font;
  const tt = Chart.defaults.plugins.tooltip;
  tt.backgroundColor = surface;
  tt.titleColor = ink;
  tt.bodyColor = muted;
  tt.borderColor = line;
  tt.borderWidth = 1;
  tt.padding = 10;
  tt.cornerRadius = 8;
  tt.boxPadding = 4;
  Chart.defaults.plugins.legend.labels.color = muted;
  const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  Chart.defaults.animation.duration = reduce ? 0 : 400;
  Chart.getChart && Object.values(Chart.instances || {}).forEach((c) => { try { c.update('none'); } catch (e) { /* chart gone */ } });
}

export const compactMoney = money;
export default Chart;
