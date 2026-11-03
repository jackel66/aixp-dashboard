import React from 'react';
import Drawer from '../components/ui/Drawer.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';

// Stub from the shell wave. Builder D replaces this file in place (same name, default export,
// props { open, id, platform, onClose }).
export default function EvidenceDrawer({ open, id, onClose }) {
  return (
    <Drawer open={open} title={id ? 'Check evidence' : 'Evidence'} onClose={onClose}>
      <EmptyState title="Coming in wave 2" body="Check evidence arrives with the next build wave." />
    </Drawer>
  );
}
