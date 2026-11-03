import React from 'react';
import { NavLink, Navigate, useParams, useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import DataSourceSection from '../components/settings/DataSourceSection.jsx';
import BasisSection from '../components/settings/BasisSection.jsx';
import SeatRatesSection from '../components/settings/SeatRatesSection.jsx';
import LobMapSection from '../components/settings/LobMapSection.jsx';
import CoworkSection from '../components/settings/CoworkSection.jsx';
import FixturesSection from '../components/settings/FixturesSection.jsx';
import ThemeSection from '../components/settings/ThemeSection.jsx';

const SECTIONS = [
  { id: 'source', label: 'Data source', Cmp: DataSourceSection },
  { id: 'basis', label: 'Spend basis', Cmp: BasisSection },
  { id: 'seat-rates', label: 'Seat rates', Cmp: SeatRatesSection },
  { id: 'lob-cg', label: 'LOB-CG map', Cmp: LobMapSection },
  { id: 'cowork', label: 'Cowork rate', Cmp: CoworkSection },
  { id: 'fixtures', label: 'Fixtures', Cmp: FixturesSection },
  { id: 'theme', label: 'Theme', Cmp: ThemeSection }
];

export default function SettingsPage() {
  const { section } = useParams();
  const { search } = useLocation();
  if (!section) return <Navigate to={'/settings/basis' + search} replace />;
  const current = SECTIONS.find((s) => s.id === section);
  if (!current) return <Navigate to="/settings/basis" replace />;
  const Cmp = current.Cmp;
  return (
    <div className="page">
      <PageHeader eyebrow="Settings" title="Settings" description="Rates, mappings and sample data that shape every figure on the dashboard." />
      <div className="flex gap-8 items-start flex-wrap">
        <nav aria-label="Settings sections" className="flex flex-col gap-1" style={{ width: 220, flex: '0 0 auto' }}>
          {SECTIONS.map((s) => (
            <NavLink key={s.id} to={'/settings/' + s.id} className="nav-link" style={{ justifyContent: 'flex-start' }}>{s.label}</NavLink>
          ))}
        </nav>
        <div style={{ flex: 1, minWidth: 320 }}>
          <Cmp />
        </div>
      </div>
    </div>
  );
}
