import React from 'react';
import Card from '../charts/Card.jsx';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import { useTheme } from '../../lib/theme.jsx';

const MODES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

export default function ThemeSection() {
  const { mode, resolved, setMode } = useTheme();
  return (
    <Card id="theme" title="Theme" caption="System follows your device setting. The choice is saved in this browser only.">
      <SegmentedControl label="Theme" value={mode} options={MODES} onChange={setMode} />
      <p className="t-small text-muted m-0" style={{ marginTop: 8 }}>Showing the {resolved} theme now.</p>
    </Card>
  );
}
