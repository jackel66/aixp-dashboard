import React from 'react';
import { Outlet } from 'react-router-dom';
import Nav from './Nav.jsx';
import Sidebar from './Sidebar.jsx';
import Footer from './Footer.jsx';
import PageTransition from './PageTransition.jsx';

// Header on top, section navigation in the left column, the analytics in the right pane.
export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main" className="skip-link">Skip to content</a>
      <Nav />
      <div className="app-body">
        <Sidebar />
        <div className="app-pane">
          <main id="main" className="flex-1 flex flex-col min-w-0" tabIndex={-1}>
            <PageTransition><Outlet /></PageTransition>
          </main>
          <Footer />
        </div>
      </div>
    </div>
  );
}
