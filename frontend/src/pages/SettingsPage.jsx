import React from 'react';
import { NavLink, Navigate, useParams, useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import DataSourceSection from '../components/settings/DataSourceSection.jsx';
import BasisSection from '../components/settings/BasisSection.jsx';
import SeatRatesSection from '../components/settings/SeatRatesSection.jsx';
import LobMapSection from '../components/settings/LobMapSection.jsx';
import CoworkSection from '../components/settings/CoworkSection.jsx';
import FixturesSection from '../components/settings/FixturesSection.jsx';
import ThemeSection from '../components/settings/ThemeSection.jsx';
import UsersSection from '../components/settings/UsersSection.jsx';
import RolesSection from '../components/settings/RolesSection.jsx';
import DirectorySection from '../components/settings/DirectorySection.jsx';
import ActivitySection from '../components/settings/ActivitySection.jsx';
import { useAuth } from '../lib/auth.jsx';

// group 'data' needs settings.manage or data.manage; group 'access' needs access.manage.
// Theme is a per-browser preference and shows for anyone who can open Settings.
const SECTIONS = [
  { id: 'source', label: 'Data source', group: 'data', Cmp: DataSourceSection },
  { id: 'basis', label: 'Spend basis', group: 'data', Cmp: BasisSection },
  { id: 'seat-rates', label: 'Seat rates', group: 'data', Cmp: SeatRatesSection },
  { id: 'lob-cg', label: 'LOB-CG map', group: 'data', Cmp: LobMapSection },
  { id: 'cowork', label: 'Cowork rate', group: 'data', Cmp: CoworkSection },
  { id: 'fixtures', label: 'Fixtures', group: 'data', Cmp: FixturesSection },
  { id: 'theme', label: 'Theme', group: 'data', Cmp: ThemeSection },
  { id: 'users', label: 'Users', group: 'access', Cmp: UsersSection },
  { id: 'roles', label: 'Roles', group: 'access', Cmp: RolesSection },
  { id: 'directory', label: 'Active Directory', group: 'access', Cmp: DirectorySection },
  { id: 'activity', label: 'Sign-in activity', group: 'access', Cmp: ActivitySection }
];

export default function SettingsPage() {
  const { section } = useParams();
  const { search } = useLocation();
  const { can } = useAuth();
  const showData = can('settings.manage') || can('data.manage');
  const showAccess = can('access.manage');
  const visible = SECTIONS.filter((s) => (s.group === 'data' ? showData : showAccess));
  if (!visible.length) {
    return <div className="page"><EmptyState title="You do not have access to this page" body="Settings need the settings.manage, data.manage or access.manage permission." /></div>;
  }
  const first = visible.find((s) => s.id === 'basis') || visible[0];
  if (!section) return <Navigate to={'/settings/' + first.id + search} replace />;
  const current = visible.find((s) => s.id === section);
  if (!current) return <Navigate to={'/settings/' + first.id} replace />;
  const Cmp = current.Cmp;
  const dataItems = visible.filter((s) => s.group === 'data');
  const accessItems = visible.filter((s) => s.group === 'access');
  const link = (s) => <NavLink key={s.id} to={'/settings/' + s.id} className="nav-link" style={{ justifyContent: 'flex-start' }}>{s.label}</NavLink>;
  return (
    <div className="page">
      <PageHeader eyebrow="Settings" title="Settings" description="Rates, mappings, sample data and who can sign in." />
      <div className="flex gap-8 items-start flex-wrap">
        <nav aria-label="Settings sections" className="flex flex-col gap-1" style={{ width: 220, flex: '0 0 auto' }}>
          {dataItems.map(link)}
          {accessItems.length > 0 && <div className="t-h3 side-group" style={{ paddingLeft: 12 }}>Access</div>}
          {accessItems.map(link)}
        </nav>
        <div style={{ flex: 1, minWidth: 320 }}>
          <Cmp />
        </div>
      </div>
    </div>
  );
}
