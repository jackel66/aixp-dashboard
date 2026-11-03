import React from 'react';

// Names the unit a figure is in. Tokens and credits are never combined, so every consumption
// figure travels with one of these or the unit word in its text.
export default function UnitBadge({ unit, className = '' }) {
  if (!unit) return null;
  return <span className={'chip chip-outline ' + className} title={'Measured in ' + unit}>{unit}</span>;
}
export { UnitBadge };
