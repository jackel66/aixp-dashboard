import React, { useEffect, useState } from 'react';

// Skeletons appear only after 150 ms so quick loads never flash.
function useDelay(ms = 150) {
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), ms); return () => clearTimeout(t); }, [ms]);
  return on;
}

export function SkeletonCard({ height = 120, className = '', style }) {
  const on = useDelay();
  return <div className={'skel ' + className} style={{ height, visibility: on ? 'visible' : 'hidden', ...style }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 5, rowHeight = 28 }) {
  const on = useDelay();
  return (
    <div style={{ visibility: on ? 'visible' : 'hidden' }} aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ height: rowHeight, width: (92 - (i % 3) * 8) + '%' }} />)}
    </div>
  );
}
export default SkeletonCard;
