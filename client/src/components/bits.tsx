import type { Priority, Verification, World } from '@shared/types';
import type { Area, AreaView } from '../areas';

export function Chip({ priority, verification }: { priority: Priority; verification?: Verification }) {
  const unverified = verification === 'needs_verification' && priority !== 'P2';
  return (
    <span
      className={`chip chip-${priority}${unverified ? ' unverified' : ''}`}
      title={unverified ? `${priority}, needs check` : priority}
    >
      {priority}
    </span>
  );
}

export interface AreaHazard {
  maxWind: number;
  maxFlood: number;
  meanOutage: number;
  maxZone: number;
}

export function areaHazard(world: World, area: Area): AreaHazard {
  const set = new Set(area.hexes);
  const cells = world.hexes.filter((h) => set.has(h.hex));
  return {
    maxWind: Math.max(...cells.map((c) => c.windMph)),
    maxFlood: Math.max(...cells.map((c) => c.floodDepthFt)),
    meanOutage: cells.reduce((s, c) => s + c.towerOutagePct, 0) / (cells.length || 1),
    maxZone: Math.max(...cells.map((c) => c.analystZone)),
  };
}

// One plain-language reason for why an area is where it is in the queue.
export function actReason(a: AreaView, hz: AreaHazard): string {
  const homes = `${a.households} homes`;
  if (a.helpReplies > 0) return `${homes} · ${a.helpReplies} asked for help`;
  if (a.fieldReports > 0) return `${homes} · ${a.fieldReports} field report${a.fieldReports > 1 ? 's' : ''}`;
  if (a.claims >= 3) return `${homes} · ${a.claims} claims filed`;
  if (hz.maxFlood >= 2) return `${homes} · flood ${hz.maxFlood.toFixed(1)} ft`;
  return `${homes} · wind ${hz.maxWind} mph`;
}

export function silentReason(a: AreaView, hz: AreaHazard): string {
  const base = `${a.smsReplies} of ${a.smsSent} replied`;
  if (hz.meanOutage >= 40) return `${base} · towers ${Math.round(hz.meanOutage)}% down`;
  if (hz.maxFlood >= 2) return `${base} · flood ${hz.maxFlood.toFixed(1)} ft`;
  return `${base} · wind ${hz.maxWind} mph`;
}

export const ZONE_LABEL = ['none', 'moderate', 'severe'] as const;
