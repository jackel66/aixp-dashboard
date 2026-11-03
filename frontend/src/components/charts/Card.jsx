import React from 'react';

// Shared card look: white, radius 10, soft shadow, 14 px padding.
export default function Card({ title, subtitle, right, className = '', children, style, id }) {
  return (
    <section id={id} className={'bg-white ' + className} style={{ borderRadius: 10, boxShadow: 'var(--shadow-card)', padding: 14, minWidth: 0, ...style }}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-3" style={{ marginBottom: 10 }}>
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="font-semibold text-t3-navy m-0" style={{ fontSize: 13, lineHeight: '18px' }}>{title}</h2>}
            {subtitle && <p className="text-t3-grey m-0" style={{ fontSize: 11, lineHeight: '15px', marginTop: 1 }}>{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}
