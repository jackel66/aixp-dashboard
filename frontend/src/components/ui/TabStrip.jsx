import React, { useRef } from 'react';

// Horizontal tabs above a set of panes. tabs: [{ id, label, dot, title }] where dot is
// 'ok' | 'warn' | 'faint' | null. Arrow keys, Home and End move and select.
export function TabDot({ tone, title }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--faint)';
  return <span aria-hidden="true" title={title} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, flex: '0 0 auto', background: tone === 'faint' ? 'transparent' : color, border: '2px solid ' + color, boxSizing: 'border-box' }} />;
}

export default function TabStrip({ label, tabs, value, onChange, idPrefix = 'tab' }) {
  const refs = useRef({});
  const onKey = (e, i) => {
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null) return;
    e.preventDefault();
    onChange(tabs[j].id);
    const el = refs.current[tabs[j].id];
    if (el) el.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tab-strip">
      {tabs.map((t, i) => {
        const on = t.id === value;
        return (
          <button key={t.id} type="button" role="tab" id={idPrefix + '-' + t.id} aria-selected={on} aria-controls={idPrefix + '-pane-' + t.id}
            tabIndex={on ? 0 : -1} ref={(el) => { refs.current[t.id] = el; }} className="tab" title={t.title}
            onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>
            {t.dot && <TabDot tone={t.dot} />}<span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// A pane stays mounted when inactive so unsaved edits and in-flight work survive a tab switch.
export function TabPane({ id, idPrefix = 'tab', active, children }) {
  return <div role="tabpanel" id={idPrefix + '-pane-' + id} aria-labelledby={idPrefix + '-' + id} hidden={!active}>{children}</div>;
}
