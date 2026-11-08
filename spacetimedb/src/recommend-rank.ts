// Pure ranking for the adjuster "Next best" list. No imports, so scripts can run it under plain Node.
//
// Order: cell priority first (a nearer P1 never beats a P0), then value per minute within a priority.

export const REC = {
  maxRows: 10,
  perCell: 3,
  roadFactor: 1.3, // straight line -> road distance
  speedKmh: 35, // post-disaster driving speed
  serviceMin: 15, // time on site
  agingMin: 360, // same as QUEUE_AGING_MIN in src/fusion
} as const;

export interface LatLng {
  lat: number;
  lng: number;
}

interface Base extends LatLng {
  householdId: string;
  hex: string;
  priority: string;
}

export interface WelfareCandidate extends Base {
  kind: 'welfare';
  weight: number;
  waitSinceMin: number;
  vulnerable: boolean;
}

export interface InspectionCandidate extends Base {
  kind: 'inspection';
  inspectScore: number;
  pSevere: number;
  verifiedInCell: number;
}

export type Candidate = WelfareCandidate | InspectionCandidate;

export interface Ranked {
  rank: number;
  householdId: string;
  hex: string;
  kind: Candidate['kind'];
  priority: string;
  score: number;
  distanceKm: number;
  etaMin: number;
  reason: string;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function tierOf(priority: string): number {
  return priority === 'P0' ? 0 : priority === 'P1' ? 1 : priority === 'P2' ? 2 : 3;
}

export function valueOf(c: Candidate, nowMin: number): number {
  if (c.kind === 'welfare') {
    const waitMin = Math.max(0, nowMin - c.waitSinceMin);
    return 0.5 + 0.5 * Math.min(1, c.weight * (1 + waitMin / REC.agingMin));
  }
  return c.inspectScore * (2 / (2 + c.verifiedInCell));
}

export function reasonOf(c: Candidate, nowMin: number): string {
  if (c.kind === 'welfare') {
    const hours = Math.round(Math.max(0, nowMin - c.waitSinceMin) / 60);
    const wait = hours < 1 ? 'no reply < 1 h' : `no reply ${hours} h`;
    return c.vulnerable ? `Vulnerable · ${wait}` : wait.charAt(0).toUpperCase() + wait.slice(1);
  }
  if (c.verifiedInCell === 0) return 'Inspect · first in area';
  return c.pSevere >= 0.5 ? 'Inspect · likely severe' : 'Inspect · damage unclear';
}

/** Best tasks for an adjuster at `from`. A household that is both a welfare and an inspection candidate stays welfare. */
export function rankCandidates(
  candidates: readonly Candidate[],
  from: LatLng,
  nowMin: number,
  excluded: ReadonlySet<string> = new Set()
): Ranked[] {
  const unique = new Map<string, Candidate>();
  for (const c of candidates) {
    if (excluded.has(c.householdId) || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const seen = unique.get(c.householdId);
    if (!seen || (seen.kind === 'inspection' && c.kind === 'welfare')) unique.set(c.householdId, c);
  }

  const scored = [...unique.values()].map(c => {
    const distanceKm = haversineKm(from, c);
    const driveMin = ((distanceKm * REC.roadFactor) / REC.speedKmh) * 60;
    return { c, tier: tierOf(c.priority), distanceKm, driveMin, score: valueOf(c, nowMin) / (driveMin + REC.serviceMin) };
  });
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.c.householdId < b.c.householdId ? -1 : 1));

  const perCell = new Map<string, number>();
  const out: Ranked[] = [];
  for (const { c, distanceKm, driveMin, score } of scored) {
    const used = perCell.get(c.hex) ?? 0;
    if (used >= REC.perCell) continue;
    perCell.set(c.hex, used + 1);
    out.push({
      rank: out.length + 1,
      householdId: c.householdId,
      hex: c.hex,
      kind: c.kind,
      priority: c.priority,
      score,
      distanceKm: Math.round(distanceKm * 100) / 100,
      etaMin: Math.max(1, Math.round(driveMin)),
      reason: reasonOf(c, nowMin),
    });
    if (out.length === REC.maxRows) break;
  }
  return out;
}
