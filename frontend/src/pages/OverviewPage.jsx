import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader.jsx';
import FilterBar from '../components/FilterBar.jsx';
import Card from '../components/charts/Card.jsx';
import TrendChart, { bucketsToSeries } from '../components/charts/TrendChart.jsx';
import ShareDonut from '../components/charts/ShareDonut.jsx';
import StatTile from '../components/analytics/StatTile.jsx';
import DataState from '../components/DataState.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import Chip from '../components/ui/Chip.jsx';
import { useDrawers } from '../drawers/DrawerHost.jsx';
import { useQuery } from '../lib/query.js';
import { useUrlFilters, apiParams } from '../lib/filters.js';
import { container, item } from '../lib/motion.js';
import { BASIS_LABEL, PLATFORM_IDS, platformName } from '../lib/platforms.js';
import { money, moneyFull, count, compactCount, pct, dateLong } from '../lib/format.js';

const DEFAULTS = { basis: 'consumption', bucket: 'week' };
const BUCKETS = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }];

function sumUnit(platforms, unit) {
  return platforms.filter((p) => p.consumption.unit === unit).reduce((a, p) => a + (p.consumption.value || 0), 0);
}

export default function OverviewPage() {
  const { values, set } = useUrlFilters(DEFAULTS);
  const { openUser } = useDrawers();
  const basis = values.basis;
  const range = apiParams(values, ['from', 'to']);
  const summary = useQuery('/summary', { ...range, basis });
  const trend = useQuery('/trend', { ...range, grain: values.bucket, basis });
  const org = useQuery('/organization', { ...range, dim: 'lob_cg', measure: 'spend', basis });
  const users = useQuery('/users', { ...range, sort: 'usd', dir: 'desc', pageSize: 10 });

  const s = summary.data;
  const shownRange = s ? { from: values.from || s.range.from, to: values.to || s.range.to } : null;

  return (
    <div className="page">
      <PageHeader eyebrow="Executive view" title="Overview"
        description={s ? 'Spend and consumption across four platforms, ' + dateLong(shownRange.from) + ' to ' + dateLong(shownRange.to) + '.' : 'Spend and consumption across four platforms.'}
        right={s ? <Chip tone="outline">As of {dateLong(s.asOf)}</Chip> : null} />
      <FilterBar values={values} set={set} asOf={s ? s.asOf : ''} range={shownRange} showRange={!!s} />
      <DataState q={summary} skeleton={<div className="stack-32"><SkeletonCard height={110} /><SkeletonCard height={300} /></div>}>
        {(sm) => {
          const tokens = sumUnit(sm.platforms, 'tokens');
          const credits = sumUnit(sm.platforms, 'credits');
          const o = org.data;
          const raw = o ? o.totals.total.usd : null;
          const unmatched = o ? (o.rows.find((r) => r.key === '__unmatched__') || { total: { usd: 0 } }).total.usd : 0;
          const coverage = raw ? ((raw - unmatched) / raw) * 100 : null;
          const shareItems = sm.platforms.map((p) => ({ id: p.id, label: p.name, value: p.spend[basis].usd }));
          return (
            <div className="stack-32">
              <motion.section variants={container} initial="hidden" animate="show" aria-label="Key figures"
                className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                <motion.div variants={item}><StatTile label={BASIS_LABEL[basis] + ' spend'} value={sm.totals.spend[basis].usd} format={money} sub="US dollars, selected range" /></motion.div>
                {basis !== 'consumption' && <motion.div variants={item}><StatTile label="Consumption spend" value={sm.totals.spend.consumption.usd} format={money} sub="US dollars, usage cost" /></motion.div>}
                {basis !== 'seat' && <motion.div variants={item}><StatTile label="Seat spend" value={sm.totals.spend.seat.usd} format={money} sub="US dollars, licensed seats" /></motion.div>}
                <motion.div variants={item}><StatTile label="Tokens" value={tokens} format={(n) => compactCount(n)} unit="tokens" sub="Anthropic and OpenAI" /></motion.div>
                <motion.div variants={item}><StatTile label="Credits" value={credits} format={(n) => compactCount(n)} unit="credits" sub="GitHub Copilot and Cowork" /></motion.div>
                <motion.div variants={item}><StatTile label="Active users" value={sm.totals.active_users} format={(n) => count(n)} sub="Distinct people, all platforms" /></motion.div>
                <motion.div variants={item}><StatTile label="Attribution coverage" value={coverage || 0} format={(n) => pct(n)} sub={coverage === null ? 'Loading' : 'Spend matched to a person'} ready={!!o} /></motion.div>
              </motion.section>

              <div className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
                <Card title="Spend trend" caption={'US dollars per ' + values.bucket + ', ' + basis + ' basis, stacked by platform.'}
                  right={<SegmentedControl label="Trend grain" value={values.bucket} options={BUCKETS} onChange={(v) => set({ bucket: v })} />}>
                  <DataState q={trend} skeleton={<SkeletonCard height={280} />}>
                    {(t) => <SpendTrend t={t} />}
                  </DataState>
                </Card>
                <Card title="Share by platform" caption={'US dollars, ' + basis + ' basis, selected range. Total in the centre.'}>
                  <ShareDonut items={shareItems} ariaLabel={'Donut chart of ' + basis + ' spend share by platform'} />
                </Card>
                <Card title="Active users" caption="Distinct active people per period, all platforms combined.">
                  <DataState q={trend} skeleton={<SkeletonCard height={220} />}>
                    {(t) => <UsersTrend t={t} />}
                  </DataState>
                </Card>
                <Card title="Raw and attributed spend" caption="US dollars per platform, consumption basis. Raw includes usage that did not resolve to a person.">
                  <DataState q={org} skeleton={<SkeletonCard height={220} />}>
                    {(od) => <RawVsAttributed o={od} />}
                  </DataState>
                </Card>
              </div>

              <Card title="Top 10 users by spend" caption={'US dollars of usage cost. Open a name for detail.'}>
                <DataState q={users} skeleton={<SkeletonCard height={260} />}>
                  {(u) => (u.rows.length ? (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="tbl">
                        <thead><tr><th>User</th><th>LOB-CG</th><th>Region</th><th className="r">Active days</th><th className="r">Spend (USD)</th></tr></thead>
                        <tbody>
                          {u.rows.map((r) => (
                            <tr key={r.person_key} className="row-btn" onClick={() => openUser(r.person_key)}>
                              <td><button type="button" className="row-button" onClick={(e) => { e.stopPropagation(); openUser(r.person_key); }}>{r.display_name || r.person_key}</button></td>
                              <td>{r.lob_cg}</td>
                              <td>{r.region}</td>
                              <td className="r num">{count(r.active_days)}</td>
                              <td className="r num" title={moneyFull(r.usd)}>{money(r.usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <EmptyState title="No users in this range" body="Widen the date range to see activity." />)}
                </DataState>
              </Card>
            </div>
          );
        }}
      </DataState>
    </div>
  );
}

function SpendTrend({ t }) {
  const labels = useMemo(() => t.buckets.map((b) => b.label), [t]);
  const series = useMemo(() => bucketsToSeries(t.buckets, PLATFORM_IDS).map((s) => ({ ...s, label: platformName(s.id) })), [t]);
  return <TrendChart labels={labels} series={series} stacked total ariaLabel={'Stacked bars of spend in US dollars per ' + t.grain + ' by platform'} />;
}

function UsersTrend({ t }) {
  const labels = useMemo(() => t.buckets.map((b) => b.label), [t]);
  const series = useMemo(() => [{ id: 'users', label: 'Active users', token: 'accent', data: t.buckets.map((b) => b.active_users) }], [t]);
  return <TrendChart type="line" height={220} labels={labels} series={series} valueFormat={(v) => count(v)} axisTitle="Active users" ariaLabel={'Line chart of distinct active users per ' + t.grain} />;
}

function RawVsAttributed({ o }) {
  const um = o.rows.find((r) => r.key === '__unmatched__');
  const labels = PLATFORM_IDS.map((id) => platformName(id));
  const raw = PLATFORM_IDS.map((id) => (o.totals.cells[id] ? o.totals.cells[id].usd : 0));
  const attributed = PLATFORM_IDS.map((id, i) => raw[i] - (um && um.cells[id] ? um.cells[id].usd : 0));
  const series = [
    { id: 'raw', label: 'Raw', token: 'faint', data: raw },
    { id: 'attributed', label: 'Attributed', token: 'accent', data: attributed }
  ];
  return <TrendChart height={220} labels={labels} series={series} ariaLabel="Grouped bars comparing raw and attributed spend in US dollars for each platform" />;
}
