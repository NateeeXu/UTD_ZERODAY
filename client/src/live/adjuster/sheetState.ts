// Tasks sheet position, remembered. TasksView unmounts on every tab change, so the value is kept here at
// module level (survives Tasks -> Messages -> Tasks) and mirrored to sessionStorage (survives a reload in
// the same browser tab). A new tab or a fresh app launch starts at 'next', so a 'peek' never sticks for good.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

export type SheetState = 'peek' | 'next' | 'all';

const KEY = 'adj-sheet-v1';
const DEFAULT: SheetState = 'next';
const isSheet = (v: unknown): v is SheetState => v === 'peek' || v === 'next' || v === 'all';

let current: SheetState | null = null; // read lazily, on first use

function load(): SheetState {
  try {
    const v = sessionStorage.getItem(KEY);
    return isSheet(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Like useState<SheetState>, but the last value outlives the component. The setter takes a value or an updater. */
export function useStickySheet(): [SheetState, Dispatch<SetStateAction<SheetState>>] {
  const [sheet, setSheet] = useState<SheetState>(() => (current ??= load()));
  useEffect(() => {
    current = sheet;
    try {
      sessionStorage.setItem(KEY, sheet);
    } catch {
      // storage blocked (private mode, quota): the module value still covers tab switches
    }
  }, [sheet]);
  return [sheet, setSheet];
}
