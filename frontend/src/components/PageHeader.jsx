import React from 'react';

export default function PageHeader({ eyebrow, title, description, right, display = false }) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap" style={{ marginBottom: 24 }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow && <div className="t-h3" style={{ marginBottom: 6 }}>{eyebrow}</div>}
        <h1 className={display ? 't-display' : 't-h1'}>{title}</h1>
        {description && <p className="text-muted" style={{ marginTop: 6, maxWidth: 640 }}>{description}</p>}
      </div>
      {right && <div className="flex items-center gap-3 flex-wrap">{right}</div>}
    </div>
  );
}
