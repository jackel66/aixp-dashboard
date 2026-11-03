import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import CountUp from './CountUp.jsx';
import Sparkline from './analytics/Sparkline.jsx';
import UnitBadge from './ui/UnitBadge.jsx';
import StatusChip from './ui/StatusChip.jsx';
import { item } from '../lib/motion.js';
import { money, units, count, lag } from '../lib/format.js';

// Landing card for one platform. The platform colour marks identity only (top rule, sparkline).
export default function PlatformCard({ platform, basis = 'consumption' }) {
  const p = platform;
  const usd = p.spend && p.spend[basis] ? p.spend[basis].usd : 0;
  return (
    <motion.div variants={item}>
      <Link to={'/platforms/' + p.id} className="card card-hover block no-underline" style={{ borderTop: '3px solid var(--p-' + p.id + ')', color: 'inherit' }}
        aria-label={p.name + ', ' + money(usd) + ' ' + basis + ' spend'}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="t-h2 m-0">{p.name}</h3>
          <UnitBadge unit={p.unit} />
        </div>
        <div className="t-stat" style={{ marginTop: 10 }}><CountUp value={usd} format={money} /></div>
        <div className="t-small text-muted">{basis} spend</div>
        <dl className="grid grid-cols-2 gap-3 m-0" style={{ marginTop: 12 }}>
          <div><dt className="t-micro text-muted">Consumption</dt><dd className="m-0 num">{units(p.consumption.value, p.consumption.unit)}</dd></div>
          <div><dt className="t-micro text-muted">Active users</dt><dd className="m-0 num">{count(p.active_users)}</dd></div>
        </dl>
        <div style={{ marginTop: 12, position: 'relative' }}>
          <Sparkline values={(p.spark || []).map((s) => s.usd)} platform={p.id} height={44} className="" />
        </div>
        <div className="t-micro text-muted" style={{ marginTop: 4 }}>Daily spend, last 30 days</div>
        {p.stale && <div style={{ marginTop: 8 }}><StatusChip status="warn">{lag(p.lag_days, true)}</StatusChip></div>}
      </Link>
    </motion.div>
  );
}
