// Background position refresh for the adjuster phone. Nothing on screen: about once a minute, while the
// page is visible, send a GPS fix (only if location access was already granted, so the browser never asks,
// and only near the region's cells), else rebuild "Next best" from the position the server already has.
// Never sends the default start: that is saved once by the caller, and the server may have moved a demo
// adjuster to a household since (after a report).
import { useEffect, useRef } from 'react';
import { cellCenter, milesBetween, type LatLng } from './derive';

const PERIOD_MS = 60_000;
/** Real GPS farther than ~15 km from every cell (e.g. a laptop in Dallas) never moves the demo adjuster. */
const NEAR_CELL_MI = 15 / 1.609344;
/** Only send a fix that moved more than ~50 m since the last one sent. */
const MIN_MOVE_MI = 50 / 1609.34;
/** Skip a tick when the sheet was touched this recently, so the Next best card never swaps under a finger. */
const QUIET_MS = 3_000;

export type ServerPos = { lat: number; lng: number; source: string };

type Opts = {
  /** Connected (the caller is only mounted while joined as an adjuster on #/adjuster). */
  active: boolean;
  /** This adjuster's adjuster_location row; refresh_recommendations needs one. */
  serverPos: ServerPos | null;
  cells: readonly { hex: string }[];
  /** A reducer call that changes the list is in flight (e.g. Accept). */
  busy: boolean;
  sendLocation: (args: { lat: number; lng: number; source: string }) => Promise<unknown>;
  refresh: () => Promise<unknown>;
};

/** A fix only when permission is already 'granted': never triggers a prompt. */
async function grantedFix(): Promise<LatLng | null> {
  try {
    if (!('geolocation' in navigator) || !navigator.permissions?.query) return null;
    const p = await navigator.permissions.query({ name: 'geolocation' });
    if (p.state !== 'granted') return null;
    return await new Promise<LatLng | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
        () => resolve(null),
        // A cached fix older than half a period is refetched, so every tick sees a recent position.
        { enableHighAccuracy: false, maximumAge: PERIOD_MS / 2, timeout: 15_000 },
      );
    });
  } catch {
    return null;
  }
}

function nearCells(p: LatLng, cells: readonly { hex: string }[]): boolean {
  return cells.some((c) => milesBetween(p, cellCenter(c.hex)) < NEAR_CELL_MI);
}

export function useBackgroundLocation(opts: Opts) {
  const ref = useRef(opts);
  ref.current = opts;
  const lastSent = useRef<LatLng | null>(null);
  const { active } = opts;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = Date.now();
    let running = false;
    let touched = 0;
    const quiet = () => alive && !ref.current.busy && Date.now() - touched >= QUIET_MS;

    const tick = async () => {
      last = Date.now();
      if (running || !quiet()) return; // skip this tick; the next one is a minute away
      running = true;
      try {
        const fix = await grantedFix();
        if (!quiet()) return; // the lookup can take a while: re-check before changing the list
        const o = ref.current;
        if (fix && nearCells(fix, o.cells)) {
          const from = lastSent.current ?? (o.serverPos?.source === 'gps' ? [o.serverPos.lat, o.serverPos.lng] as LatLng : null);
          if (!from || milesBetween(from, fix) > MIN_MOVE_MI) {
            await o.sendLocation({ lat: fix[0], lng: fix[1], source: 'gps' }); // also rebuilds the list
            lastSent.current = fix;
            return;
          }
        }
        if (o.serverPos) await o.refresh();
      } catch {
        // Silent: the next tick tries again.
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!alive || document.visibilityState === 'hidden') return; // paused while hidden
      timer = setTimeout(() => { void tick().finally(schedule); }, Math.max(1_000, last + PERIOD_MS - Date.now()));
    };
    const onTouch = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.adj-sheet')) touched = Date.now();
    };
    const touchEvents = ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'scroll', 'keydown'] as const;
    for (const t of touchEvents) document.addEventListener(t, onTouch, { capture: true, passive: true });
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
      for (const t of touchEvents) document.removeEventListener(t, onTouch, { capture: true });
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [active]);
}
