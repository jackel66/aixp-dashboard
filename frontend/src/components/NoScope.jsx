import React from 'react';
import EmptyState from './ui/EmptyState.jsx';

// Shown by every data page when the server answers 403 code no_scope: the account may sign in
// but has no line of business granted. err is the thrown api error (message is the server text).
export function isNoScope(err) {
  return !!(err && err.status === 403 && err.body && err.body.code === 'no_scope');
}

export default function NoScope({ err }) {
  return (
    <EmptyState
      title="No data scope is assigned to your account"
      body="Ask an administrator to grant a line of business under Settings > Data scopes, or a role that carries the data.all permission." />
  );
}
