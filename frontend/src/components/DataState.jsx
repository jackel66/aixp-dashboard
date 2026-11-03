import React from 'react';
import EmptyState from './ui/EmptyState.jsx';
import Button from './ui/Button.jsx';
import { SkeletonCard } from './ui/Skeleton.jsx';

// Shared loading, error and inline-warning handling for a useQuery result.
//   loading: skeleton after 150 ms (children render nothing until data exists)
//   error without data: EmptyState with Retry
//   error with data: inline warning above the content, last good data kept
export default function DataState({ q, skeleton, children }) {
  if (q.error && q.data === undefined) {
    return <EmptyState tone="error" title="Could not load this view" body={q.error.message || 'The request failed.'} action={<Button variant="secondary" onClick={q.reload}>Retry</Button>} />;
  }
  if (q.data === undefined) return skeleton || <SkeletonCard height={200} />;
  return (
    <>
      {q.error && (
        <div className="chip chip-warn" role="status" style={{ height: 'auto', padding: '6px 10px', marginBottom: 12 }}>
          <span aria-hidden="true">!</span> Showing the last data received. The latest refresh failed: {q.error.message}
        </div>
      )}
      {children(q.data)}
    </>
  );
}
