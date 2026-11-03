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

function Placeholder({ title }) {
  return (
    <div className="page">
      <h1 className="t-h1" style={{ marginBottom: 24 }}>{title}</h1>
      <EmptyState title="Coming in wave 2" body="This page is built in the next wave." />
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <LiveProvider>
        <ToastProvider>
          <DrawerHost>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<LandingPage />} />
                <Route path="/overview" element={<OverviewPage />} />
                <Route path="/platforms" element={<Navigate to="/platforms/anthropic" replace />} />
                <Route path="/platforms/:id" element={<PlatformPage />} />
                <Route path="/diagnostics" element={<DiagnosticsPage />} />
                {/* // D routes - Builder D swaps these placeholders for the real pages, nothing else in this file */}
                <Route path="/organization" element={<Placeholder title="Organization" />} />
                <Route path="/models" element={<Placeholder title="Models" />} />
                <Route path="/users" element={<Placeholder title="Users" />} />
                <Route path="/data-quality" element={<Placeholder title="Data quality" />} />
                <Route path="/settings/:section?" element={<Placeholder title="Settings" />} />
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
