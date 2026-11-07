// COPIED from engine/src/active.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Active inspection: where should the next adjuster go?
//
// Score = wSevere * pSevere + wHelp * pNeedsHelp + wUncertainty * uncertainty
//       + wSilence * cellSilence + wNeedsVerification * [cell needs verification]
// Verified households are excluded. The function sees neither truth nor the
// holdout flag: holdout households are ordinary customers to the adjuster;
// only the learning loop treats their reports differently.

import type { HexEstimate, HexId, Household, HouseholdEstimate, Priority, Verification, World } from '../contract.ts';
import type { TriageConfig } from './config.ts';

export interface InspectionCandidate {
  householdId: string;
  hex: HexId;
  lat: number;
  lng: number;
  score: number;
  pSevere: number;
  pNeedsHelp: number;
  uncertainty: number;
  cellSilence: number;
  cellPriority: Priority;
  cellVerification: Verification;
  reasons: string[];
}

export interface CellCandidate {
  hex: HexId;
  score: number;
  severity: number;
  confidence: number;
  silence: number;
  priority: Priority;
  verification: Verification;
}

export interface RecommendOptions {
  /** Household ids to skip (e.g. already assigned). */
  exclude?: ReadonlySet<string>;
  /** Overrides cfg.active.perCellCap. */
  perCellCap?: number;
}

function compareDesc(a: { score: number; id: string }, b: { score: number; id: string }): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function recommendInspections(
  world: World,
  households: readonly HouseholdEstimate[],
  hexes: readonly HexEstimate[],
  k: number,
  cfg: TriageConfig,
  opts: RecommendOptions = {},
): InspectionCandidate[] {
  const hexById = new Map<HexId, HexEstimate>();
  for (const x of hexes) hexById.set(x.hex, x);
  const hhById = new Map<string, Household>();
  for (const h of world.households) hhById.set(h.id, h);
  const w = cfg.active;
  const cap = opts.perCellCap ?? w.perCellCap;

  const scored: { score: number; id: string; cand: InspectionCandidate }[] = [];
  for (const e of households) {
    if (e.verified) continue;
    if (opts.exclude && opts.exclude.has(e.householdId)) continue;
    const h = hhById.get(e.householdId);
    if (!h) throw new Error(`recommendInspections: unknown household ${e.householdId}`);
    const cell = hexById.get(h.hex);
    if (!cell) throw new Error(`recommendInspections: no hex estimate for ${h.hex}`);
    const nv = cell.verification === 'needs_verification' ? 1 : 0;
    const score =
      w.wSevere * e.pSevere + w.wHelp * e.pNeedsHelp + w.wUncertainty * e.uncertainty + w.wSilence * cell.silence + w.wNeedsVerification * nv;
    const reasons: string[] = [];
    if (e.pNeedsHelp >= 0.25) reasons.push(`pNeedsHelp ${e.pNeedsHelp.toFixed(2)}`);
    if (e.pSevere >= 0.4) reasons.push(`pSevere ${e.pSevere.toFixed(2)}`);
    if (e.uncertainty >= 0.5) reasons.push(`uncertain ${e.uncertainty.toFixed(2)}`);
    if (cell.silence >= 0.3) reasons.push(`silent cell ${cell.silence.toFixed(2)}`);
    if (nv) reasons.push('cell needs verification');
    scored.push({
      score,
      id: e.householdId,
      cand: {
        householdId: e.householdId,
        hex: h.hex,
        lat: h.lat,
        lng: h.lng,
        score,
        pSevere: e.pSevere,
        pNeedsHelp: e.pNeedsHelp,
        uncertainty: e.uncertainty,
        cellSilence: cell.silence,
        cellPriority: cell.priority,
        cellVerification: cell.verification,
        reasons,
      },
    });
  }
  scored.sort(compareDesc);
  const perCell = new Map<HexId, number>();
  const out: InspectionCandidate[] = [];
  for (const s of scored) {
    if (out.length >= k) break;
    const used = perCell.get(s.cand.hex) ?? 0;
    if (used >= cap) continue;
    perCell.set(s.cand.hex, used + 1);
    out.push(s.cand);
  }
  return out;
}

/** Cells ranked by "likely bad and poorly understood". */
export function recommendCells(hexes: readonly HexEstimate[], k: number, cfg: TriageConfig): CellCandidate[] {
  const w = cfg.active;
  const scored = hexes
    .filter((x) => x.households > 0)
    .map((x) => {
      const nv = x.verification === 'needs_verification' ? 1 : 0;
      const score = w.wSevere * x.severity + w.wUncertainty * (1 - x.confidence) + w.wSilence * x.silence + w.wNeedsVerification * nv;
      return {
        score,
        id: x.hex,
        cand: {
          hex: x.hex,
          score,
          severity: x.severity,
          confidence: x.confidence,
          silence: x.silence,
          priority: x.priority,
          verification: x.verification,
        },
      };
    });
  scored.sort(compareDesc);
  return scored.slice(0, k).map((s) => s.cand);
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Nearest-neighbour visiting order from a start point (deterministic; ties by householdId). */
export function routeOrder(candidates: readonly InspectionCandidate[], start: { lat: number; lng: number }): InspectionCandidate[] {
  const remaining = candidates.slice();
  const out: InspectionCandidate[] = [];
  let cur = start;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cur, remaining[i]);
      if (d < bestD || (d === bestD && remaining[i].householdId < remaining[bestIdx].householdId)) {
        bestD = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    out.push(next);
    cur = next;
  }
  return out;
}
