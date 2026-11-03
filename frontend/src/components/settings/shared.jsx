import React, { useState } from 'react';
import Card from '../charts/Card.jsx';
import Button from '../ui/Button.jsx';
import { useToast } from '../ui/Toast.jsx';
import { api } from '../../lib/api.js';
import { clearQueryCache } from '../../lib/query.js';

// Shared pieces for the settings sections: a titled card with a Save button, and a save helper
// that shows a toast and refreshes cached reads.
export function useSaver() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (call, okMessage) => {
    setSaving(true);
    try {
      await call();
      toast.success(okMessage || 'Saved');
      clearQueryCache();
      return true;
    } catch (e) {
      toast.error(e.message || 'Could not save');
      return false;
    } finally { setSaving(false); }
  };
  return { save, saving };
}

export function SectionCard({ id, title, caption, dirty, saving, onSave, saveLabel = 'Save changes', disabled, extra, children }) {
  return (
    <Card id={id} title={title} caption={caption}>
      {children}
      {onSave && (
        <div className="flex items-center gap-3" style={{ marginTop: 16 }}>
          <Button onClick={onSave} disabled={!dirty || saving || disabled}>{saving ? 'Saving' : saveLabel}</Button>
          {dirty && !saving && <span className="t-small text-muted">Unsaved changes</span>}
          {extra}
        </div>
      )}
    </Card>
  );
}

export function Field({ label, hint, children, htmlFor }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={htmlFor} className="block" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <p className="t-small text-muted m-0" style={{ marginTop: 4 }}>{hint}</p>}
    </div>
  );
}
