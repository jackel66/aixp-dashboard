import React from 'react';
import Chip from './ui/Chip.jsx';
import Tooltip from './ui/Tooltip.jsx';
import { dateLong } from '../lib/format.js';

// Where a dataset came from: a Power BI pull (source 'import', options.provider 'powerbi') or a fixture.
export function datasetSource(ds) {
  if (!ds) return { kind: 'unknown', label: '', name: '' };
  const opts = ds.options || {};
  const powerbi = opts.provider === 'powerbi' || ds.provider === 'powerbi';
  if (powerbi) return { kind: 'powerbi', label: 'Power BI pull', name: opts.dataset_name || ds.dataset_name || ds.label || '' };
  if (ds.source === 'fixture') return { kind: 'fixture', label: 'Fixture', name: '' };
  return { kind: 'other', label: ds.source || '', name: '' };
}

export function sourceLine(ds) {
  const s = datasetSource(ds);
  if (s.kind === 'powerbi') return 'Source: Power BI pull' + (s.name ? ' ' + s.name : '');
  if (s.kind === 'fixture') return 'Source: fixture';
  return s.label ? 'Source: ' + s.label : '';
}

// The "As of" chip with a tooltip that names the dataset source.
export default function AsOfChip({ asOf, dataset }) {
  const text = sourceLine(dataset);
  const chip = <Chip tone="outline" tabIndex={text ? 0 : undefined}>As of {dateLong(asOf)}</Chip>;
  return text ? <Tooltip text={text}>{chip}</Tooltip> : chip;
}
