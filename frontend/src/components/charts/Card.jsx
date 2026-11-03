import React from 'react';

// Shared card: bg-1 surface, radius 12, padding 16. Title is an h2, caption names units and basis.
export default function Card({ title, caption, right, className = '', children, style, id, as: As = 'section', hover = false, ...rest }) {
  return (
    <As id={id} className={'card ' + (hover ? 'card-hover ' : '') + className} style={style} {...rest}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-3" style={{ marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="t-h2 m-0">{title}</h2>}
            {caption && <p className="t-small text-muted m-0" style={{ marginTop: 2 }}>{caption}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </As>
  );
}
export { Card };
