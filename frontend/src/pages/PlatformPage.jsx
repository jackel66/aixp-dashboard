import React, { useMemo } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader.jsx';
import FilterBar from '../components/FilterBar.jsx';
import Card from '../components/charts/Card.jsx';
import TrendChart from '../components/charts/TrendChart.jsx';
import StatTile from '../components/analytics/StatTile.jsx';
import DataState from '../components/DataState.jsx';
import SegmentedControl from '../components/ui/SegmentedControl.jsx';
import StatusChip from '../components/ui/StatusChip.jsx';
import UnitBadge from '../components/ui/UnitBadge.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import Button from '../components/ui/Button.jsx';
import Chip from '../components/ui/Chip.jsx';
import { SkeletonCard } from '../components/ui/Skeleton.jsx';
import { useDrawers } from '../drawers/DrawerHost.jsx';
import { useQuery } from '../lib/query.js';
import { useAuth } from '../lib/auth.jsx';
import { useUrlFilters, apiParams } from '../lib/filters.js';
import { PLATFORMS, BY_ID, BASIS_LABEL } from '../lib/platforms.js';
import { money, moneyFull, count, compactCount, units, lag, dateLong, dateShort, pctChange, pct } from '../lib/format.js';

const DEFAULTS = { basis: 'consumption' };
const SWITCH = PLATFORMS.map((p) => ({ value: p.id, label: p.name }));

export default function PlatformPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const meta = BY_ID[id];
  const { values, set } = useUrlFilters(DEFAULTS);

  const header = (
    <PageHeader eyebrow="Platform" title={meta ? meta.name : 'Unknown platform'}
      right={<SegmentedControl label="Platform" value={id} options={SWITCH} onChange={(v) => navigate('/platforms/' + v + search)} />} />
  );
  if (!meta) {
    return (
      <div className="page">
        {header}
        <EmptyState title="That platform does not exist" body="Pick one of the four platforms above." action={<Button as="a" href="/platforms/anthropic">Open Anthropic</Button>} />
      </div>
    );
  }
  return <PlatformBody key={id} id={id} meta={meta} header={header} values={values} set={set} />;
}

function PlatformBody({ id, meta, header, values, set }) {
  const basis = values.basis;
  const range = apiParams(values, ['from', 'to']);
  const q = useQuery('/platforms/' + id, { ...range, basis });
  const d = q.data;
  const shownRange = d ? { from: values.from || d.coverage.from, to: values.to || d.coverage.to } : null;
  return (
    <div className="page">
      {header}
      <FilterBar values={values} set={set} asOf={d ? d.asOf : ''} range={shownRange} showRange={!!d} />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
        <DataState q={q} skeleton={<div className="stack-32"><SkeletonCard height={110} /><SkeletonCard height={300} /></div>}>
          {(p) => <PlatformContent p={p} basis={basis} />}
        </DataState>
      </motion.div>
    </div>
  );
}

function PlatformContent({ p, basis }) {
  const { openUser, openModel, openCheck } = useDrawers();
  const { can } = useAuth();
  const people = can('people.view');
  const unit = p.platform.unit;
  const cur = p.spend[basis].usd;
  const prev = p.prior && p.prior.spend ? p.prior.spend[basis].usd : null;
  const spu = p.spend_per_unit;
  const labels = useMemo(() => p.trend.map((t) => dateShort(t.start)), [p]);
  const spendSeries = useMemo(() => [{ id: p.platform.id, label: BASIS_LABEL[basis] + ' spend', platform: p.platform.id, data: p.trend.map((t) => t.usd) }], [p, basis]);
  const unitSeries = useMemo(() => [{ id: p.platform.id + '-units', label: 'Consumption (' + unit + ')', platform: p.platform.id, data: p.trend.map((t) => t.consumption.value) }], [p, unit]);

  return (
    <div className="stack-32">
      {p.platform.id === 'cowork' && p.cowork && (
        <div className="card flex items-center gap-3 flex-wrap" role="note">
          <p className="m-0" style={{ flex: 1, minWidth: 260 }}>
            Cowork reports cumulative monthly credits used. Credits are valued at {p.cowork.rate} US dollars each to give an estimated cost.
          </p>
          {!p.cowork.confirmed && <StatusChip status="warn">Reconfirm rate</StatusChip>}
        </div>
      )}

      <section aria-label="Key figures" className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <StatTile label={BASIS_LABEL[basis] + ' spend'} value={cur} format={money} change={prev === null ? null : pctChange(cur, prev)} sub="US dollars, vs previous period of equal length" />
        <StatTile label="Consumption" value={p.consumption.value} format={(n) => compactCount(n)} unit={unit} sub={'Total ' + unit + ' in range'} />
        <StatTile label="Active users" value={p.active_users} format={(n) => count(n)} sub="Distinct people in range" />
        {spu && spu.valid && (
          <StatTile label="Spend per million tokens" value={spu.usd * 1e6} format={(n) => '$' + n.toFixed(2)} sub="Consumption spend over priced token rows" />
        )}
      </section>

      {p.github && (
        <Card title="Gross, discount and net" caption="US dollars in range. Shown side by side and never netted silently; consumption spend equals net.">
          <dl className="grid-16 m-0" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <div><dt className="t-small text-muted">Gross</dt><dd className="m-0 t-stat num">{moneyFull(p.github.gross)}</dd></div>
            <div><dt className="t-small text-muted">Discount</dt><dd className="m-0 t-stat num">{moneyFull(p.github.discount)}</dd></div>
            <div><dt className="t-small text-muted">Net</dt><dd className="m-0 t-stat num">{moneyFull(p.github.net)}</dd></div>
          </dl>
        </Card>
      )}

      <div className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
        <Card title="Spend trend" caption={'US dollars per week, ' + basis + ' basis.'}>
          <TrendChart labels={labels} series={spendSeries} ariaLabel={'Weekly ' + basis + ' spend in US dollars for ' + p.platform.name} />
        </Card>
        <Card title="Consumption trend" caption={'Total ' + unit + ' per week.'} right={<UnitBadge unit={unit} />}>
          <TrendChart type="line" labels={labels} series={unitSeries} valueFormat={(v) => compactCount(v)} axisTitle={unit} ariaLabel={'Weekly consumption in ' + unit + ' for ' + p.platform.name} />
        </Card>
      </div>

      <Card title="Models" caption={'Spend and ' + unit + ' by model in range.'}>
        {p.models.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Model</th><th className="r">Spend (USD)</th><th className="r">Consumption</th><th className="r">Users</th><th className="r">Share</th></tr></thead>
              <tbody>
                {p.models.map((m) => (
                  <tr key={m.model} className="row-btn" onClick={() => openModel(p.platform.id, m.model)}>
                    <td><button type="button" className="row-button" onClick={(e) => { e.stopPropagation(); openModel(p.platform.id, m.model); }}>{m.model}</button></td>
                    <td className="r num">{money(m.usd)}</td>
                    <td className="r num">{units(m.consumption.value, m.consumption.unit)}</td>
                    <td className="r num">{count(m.users)}</td>
                    <td className="r num">{pct(m.share * 100, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="This source does not report a model" body={p.platform.name + ' usage arrives without a model name, so there is no model breakdown.'} />}
      </Card>

      <div className="grid-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
        {people && <Card title="Top users" caption={'Top 20 by spend, US dollars and ' + unit + '.'}>
          <div style={{ overflow: 'auto', maxHeight: 420 }}>
            <table className="tbl compact">
              <thead><tr><th>User</th><th>LOB-CG</th><th className="r">Spend (USD)</th><th className="r">Consumption</th></tr></thead>
              <tbody>
                {p.top_users.map((u) => (
                  <tr key={u.person_key} className="row-btn" onClick={() => openUser(u.person_key)}>
                    <td><button type="button" className="row-button" onClick={(e) => { e.stopPropagation(); openUser(u.person_key); }}>{u.display_name || u.person_key}</button></td>
                    <td>{u.lob_cg}</td>
                    <td className="r num">{money(u.usd)}</td>
                    <td className="r num">{units(u.consumption.value, u.consumption.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>}

        <div className="flex flex-col gap-4">
          <Card title="Freshness" caption="How current this platform's data is on its own, not by the overall maximum date.">
            <dl className="grid grid-cols-2 gap-3 m-0">
              <div><dt className="t-small text-muted">Latest data</dt><dd className="m-0 num">{dateLong(p.as_of)}</dd></div>
              <div><dt className="t-small text-muted">Lag</dt><dd className="m-0">{p.stale ? <StatusChip status="warn">{lag(p.lag_days, true)}</StatusChip> : lag(p.lag_days, false)}</dd></div>
              <div><dt className="t-small text-muted">Coverage</dt><dd className="m-0 num">{dateShort(p.coverage.from)} to {dateShort(p.coverage.to)}, {p.coverage.days} days</dd></div>
              <div><dt className="t-small text-muted">Gaps</dt><dd className="m-0">{p.coverage.monthly ? 'Not scanned: monthly snapshots, not daily rows' : p.coverage.gaps.length ? p.coverage.gaps.map((g) => dateShort(g.from) + ' to ' + dateShort(g.to)).join(', ') : 'None'}</dd></div>
            </dl>
          </Card>
          <Card title="Checks" caption="Latest verification results for this platform.">
            {p.checks.length ? (
              <ul className="list-none p-0 m-0 flex flex-col">
                {p.checks.map((c, i) => (
                  <li key={c.id + i}>
                    <button type="button" onClick={() => openCheck(c.id, p.platform.id)}
                      className="w-full flex items-center justify-between gap-3 py-2 bg-transparent border-0 border-b border-line cursor-pointer text-left text-ink" style={{ borderBottom: '1px solid var(--line)' }}>
                      <span>{c.title}</span>
                      <StatusChip status={c.status === 'fail' ? (c.severity === 'info' ? 'info' : c.severity === 'fail' ? 'fail' : 'warn') : c.status === 'pass' ? 'pass' : 'info'} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-muted m-0">No checks ran for this platform yet.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}
