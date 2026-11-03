import React from 'react';
import Drawer from '../components/ui/Drawer.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';

// Stub from the shell wave. Builder D replaces this file in place (same name, default export,
// props { open, id, platform, model, onClose }).
export default function ModelDrawer({ open, model, onClose }) {
  return (
    <Drawer open={open} title={model || 'Model'} onClose={onClose}>
      <EmptyState title="Coming in wave 2" body="Model detail arrives with the next build wave." />
    </Drawer>
  );
}
