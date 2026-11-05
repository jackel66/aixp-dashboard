import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/charts/Card.jsx';
import TrendChart, { bucketsToSeries } from '../components/charts/TrendChart.jsx';
import CountUp from '../components/CountUp.jsx';
import FreshnessStrip from '../components/FreshnessStrip.jsx';
import ConfidenceChip from '../components/ConfidenceChip.jsx';
import PlatformCard from '../components/PlatformCard.jsx';
import { useAuth } from '../lib/auth.jsx';
import DataState from '../components/DataState.jsx';
import { DeltaChip } from '../components/analytics/StatTile.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import Chip from '../components/ui/Chip.jsx';
import AsOfChip from '../components/AsOfChip.jsx';
import { useQuery } from '../lib/query.js';
import { useUrlFilters } from '../lib/filters.js';
import { container } from '../lib/motion.js';
import { BASES, BASIS_LABEL, PLATFORM_IDS, platformName, CAVEAT } from '../lib/platforms.js';
import { money, moneyFull, pctChange, dateLong } from '../lib/format.js';

const DEFAULTS = { basis: 'consumption' };

export default function LandingPage() {
  const { values, set } = useUrlFilters(DEFAULTS);
  const basis = values.basis;
  const { scope } = useAuth();
  const scoped = !scope.all;
  const summary = useQuery('/summary', { basis });
  const trend = useQuery('/trend', { grain: 'week', basis });

  return (
    <div className="page">
      <PageHeader
        eyebrow={scoped ? 'Your lines of business' : 'Executive view'}
        title="AI platform economics"
        display
        description={scoped ? 'Spend and consumption for the lines of business granted to you.' : undefined}
        right={(
          <>
            {summary.data && <AsOfChip asOf={summary.data.asOf} dataset={summary.data.dataset} />}
            <SegmentedControl label="Spend basis" value={basis} options={BASES} onChange={(v) => set({ basis: v })} />
          </>
        )}
      />
      <DataState q={summary} skeleton={<div className="stack-32"><SkeletonCard height={150} /><SkeletonCard height={220} /></div>}>
        {(s) => {
          const cur = s.headline.spend[basis].usd;
          const prior = s.headline.prior.spend[basis].usd;
          return (
            <div className="stack-32">
              <section aria-labelledby="headline" className="card" style={{ padding: 24 }}>
                <h2 id="headline" className="t-h3 m-0">{s.headline.period.label} - {BASIS_LABEL[basis].toLowerCase()} spend</h2>
                <div className="flex items-end gap-4 flex-wrap" style={{ marginTop: 8 }}>
                  <span className="t-display" title={moneyFull(cur)}><CountUp value={cur} format={money} /></span>
                  <DeltaChip change={pctChange(cur, prior)} label={'vs ' + s.headline.prior.period.label} />
                </div>
                {scoped && s.seat_basis_note ? <p className="t-small text-muted m-0" style={{ marginTop: 8 }}>{s.seat_basis_note}</p> : null}
                <p className="text-muted m-0" style={{ marginTop: 8, maxWidth: 680 }}>
                  A directional figure in US dollars on the {basis} basis, compared with {s.headline.prior.period.label} ({money(prior)}).
                  It may not match invoices.
                </p>
                <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 16 }}>
                  <FreshnessStrip platforms={s.platforms} />
                  <ConfidenceChip confidence={s.confidence} />
                </div>
              </section>

              <motion.section variants={container} initial="hidden" animate="show" aria-label="Platforms"
                className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
                {s.platforms.map((p) => <PlatformCard key={p.id} platform={p} basis={basis} />)}
              </motion.section>

              <Card title="Weekly spend by platform" caption={'US dollars per week, ' + basis + ' basis, last 12 weeks.'}>
                <DataState q={trend} skeleton={<SkeletonCard height={280} />}>
                  {(t) => <WeeklyTrend t={t} />}
                </DataState>
              </Card>

              <p className="t-small text-muted m-0">{s.caveat || CAVEAT}</p>
            </div>
          );
        }}
      </DataState>
    </div>
  );
}

function WeeklyTrend({ t }) {
  const buckets = useMemo(() => t.buckets.slice(-12), [t]);
  const labels = useMemo(() => buckets.map((b) => b.label), [buckets]);
  const series = useMemo(() => bucketsToSeries(buckets, PLATFORM_IDS).map((s) => ({ ...s, label: platformName(s.id) })), [buckets]);
  return <TrendChart labels={labels} series={series} stacked total ariaLabel="Stacked bars of weekly spend in US dollars by platform for the last 12 weeks" />;
}
