import React from 'react';

// Empty, error-without-data and not-supported states. action: ReactNode (usually a Button).
export default function EmptyState({ title, body, action, tone = 'neutral', className = '' }) {
  return (
    <div className={'flex flex-col items-center justify-center text-center gap-2 py-10 px-4 ' + className} role={tone === 'error' ? 'alert' : undefined}>
      <div aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 12, background: tone === 'error' ? 'var(--fail-soft)' : 'var(--accent-soft)', display: 'grid', placeItems: 'center', color: 'var(--ink)', fontWeight: 700 }}>
        {tone === 'error' ? '!' : 'i'}
      </div>
      <h3 className="t-h2 m-0">{title}</h3>
      {body && <p className="text-muted m-0" style={{ maxWidth: 440 }}>{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export { EmptyState };
