import React from 'react';
import Drawer from '../components/ui/Drawer.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';

// Stub from the shell wave. Builder D replaces this file in place (same name, default export,
// props { open, id, onClose }).
export default function UserDrawer({ open, id, onClose }) {
  return (
    <Drawer open={open} title={id ? 'User ' + id : 'User'} onClose={onClose}>
      <EmptyState title="Coming in wave 2" body="User detail arrives with the next build wave." />
    </Drawer>
  );
}
