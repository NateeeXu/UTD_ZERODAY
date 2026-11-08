import { useMemo } from 'react';
import { LiveProvider } from './LiveProvider';
import { initialLiveRegion } from './config';
import { AdjusterApp } from './adjuster/AdjusterApp';

// Adjuster phone at #/adjuster. The screens live in ./adjuster (docs/ADJUSTER_APP.md).
export function AdjusterLive() {
  const region = useMemo(initialLiveRegion, []);
  return (
    <LiveProvider screen="adjuster" db={region.db!}>
      <AdjusterApp />
    </LiveProvider>
  );
}
