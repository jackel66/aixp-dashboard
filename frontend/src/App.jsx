import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AuthGate from './components/AuthGate.jsx';
import Layout from './components/Layout.jsx';
import { LiveProvider } from './lib/live.jsx';
import { ToastProvider } from './components/ui/Toast.jsx';
import DrawerHost from './drawers/DrawerHost.jsx';
import EmptyState from './components/ui/EmptyState.jsx';
import LandingPage from './pages/LandingPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import PlatformPage from './pages/PlatformPage.jsx';
import DiagnosticsPage from './pages/DiagnosticsPage.jsx';
import OrganizationPage from './pages/OrganizationPage.jsx';
import ModelsPage from './pages/ModelsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import DataQualityPage from './pages/DataQualityPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ReportPage from './pages/ReportPage.jsx';
import HelpPage from './pages/HelpPage.jsx';
import { useAuth, AccessWatcher } from './lib/auth.jsx';

function Placeholder({ title }) {
  return (
    <div className="page">
      <h1 className="t-h1" style={{ marginBottom: 24 }}>{title}</h1>
      <EmptyState title="Coming in wave 2" body="This page is built in the next wave." />
    </div>
  );
}

// The landing route: dashboards for dashboard.view, else the first page the user can see.
function Home() {
  const { can } = useAuth();
  if (can('dashboard.view')) return <LandingPage />;
  if (can('settings.manage') || can('data.manage') || can('access.manage')) return <Navigate to="/settings" replace />;
  return <div className="page"><EmptyState title="You do not have access to this page" body="Your role has no pages assigned. Ask an administrator." /></div>;
}

export default function App() {
  return (
    <AuthGate>
      <LiveProvider>
        <AccessWatcher />
        <ToastProvider>
          <DrawerHost>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Home />} />
                <Route path="/overview" element={<OverviewPage />} />
                <Route path="/platforms" element={<Navigate to="/platforms/anthropic" replace />} />
                <Route path="/platforms/:id" element={<PlatformPage />} />
                <Route path="/help" element={<HelpPage />} />
                <Route path="/diagnostics" element={<DiagnosticsPage />} />
                {/* // D routes - Builder D swaps these placeholders for the real pages, nothing else in this file */}
                <Route path="/organization" element={<OrganizationPage />} />
                <Route path="/models" element={<ModelsPage />} />
                <Route path="/users" element={<UsersPage />} />
                <Route path="/data-quality" element={<DataQualityPage />} />
                <Route path="/settings/:section?" element={<SettingsPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/reports/:id" element={<ReportPage />} />
                {/* // end D routes */}
                <Route path="*" element={<div className="page"><EmptyState title="Page not found" body="That address does not match a page." /></div>} />
              </Route>
            </Routes>
          </DrawerHost>
        </ToastProvider>
      </LiveProvider>
    </AuthGate>
  );
}
