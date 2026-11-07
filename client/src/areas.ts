// Groups hexes into named "areas" (their H3 resolution-7 parent, ~7 hexes,
// ~5 km²) so the manager reads "Seawall Point" instead of 8848906c01fffff.
// Names are made up and assigned deterministically from the sorted parent ids.
import { cellToLatLng, cellToParent } from 'h3-js';
import type { HexId, Priority, Verification, World } from '@shared/types';
import type { HexView } from './engine/placeholderEstimate';

const PREFIX = [
  'Seawall', 'Pelican', 'Oyster', 'Heron', 'Cypress', 'Magnolia', 'Bayou', 'Marsh', 'Saltgrass',
  'Driftwood', 'Live Oak', 'Tidewater', 'Gulfview', 'Harbor', 'Pecan', 'Lighthouse', 'Egret',
  'Sandpiper', 'Palmetto', 'Cedar', 'Willow', 'Redfish', 'Shell', 'Mesquite', 'Bluewater',
];
const SUFFIX = ['Point', 'Flats', 'Heights', 'Row', 'Landing', 'Shores', 'Park', 'Village', 'Hill', 'Bend'];

export interface Area {
  id: HexId;           // res-7 parent cell
  name: string;
  hexes: HexId[];
  lat: number;
  lng: number;
}

export interface AreaView {
  area: Area;
  priority: Priority;
  verification: Verification;
  households: number;
  helpReplies: number;
  smsSent: number;
  smsReplies: number;
  claims: number;
  expectedClaims: number;
  fieldReports: number;
  expectedSevere: number;
  maxPNeedsHelp: number;
  silence: number;      // household-weighted
  hazard: number;       // household-weighted
  confidence: number;   // household-weighted
  severity: number;     // max over hexes
}

export function buildAreas(world: World): { areas: Area[]; areaOfHex: Map<HexId, Area> } {
  const groups = new Map<HexId, HexId[]>();
  for (const h of world.hexes) {
    const p = cellToParent(h.hex, 7);
    const g = groups.get(p);
    if (g) g.push(h.hex);
    else groups.set(p, [h.hex]);
  }
  const ids = [...groups.keys()].sort();
  const areas: Area[] = ids.map((id, i) => {
    // Stride through prefix×suffix so neighbours don't share a prefix.
    const k = (i * 7) % (PREFIX.length * SUFFIX.length);
    const [lat, lng] = cellToLatLng(id);
    return { id, name: `${PREFIX[k % PREFIX.length]} ${SUFFIX[Math.floor(k / PREFIX.length) % SUFFIX.length]}`, hexes: groups.get(id)!, lat, lng };
  });
  const areaOfHex = new Map<HexId, Area>();
  for (const a of areas) for (const h of a.hexes) areaOfHex.set(h, a);
  return { areas, areaOfHex };
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

export function aggregateAreas(areas: Area[], hexById: Map<HexId, HexView>): AreaView[] {
  const out: AreaView[] = [];
  for (const area of areas) {
    const hs = area.hexes.map((id) => hexById.get(id)).filter((h): h is HexView => !!h);
    if (!hs.length) continue;
    const n = hs.reduce((s, h) => s + h.households, 0) || 1;
    const w = (f: (h: HexView) => number) => hs.reduce((s, h) => s + f(h) * h.households, 0) / n;
    const priority = hs.reduce<Priority>((p, h) => (RANK[h.priority] < RANK[p] ? h.priority : p), 'P2');
    // Unverified if most households in the hexes that drive the priority are unverified.
    const driving = hs.filter((h) => h.priority === priority);
    const dn = driving.reduce((s, h) => s + h.households, 0) || 1;
    const unverified = driving.filter((h) => h.verification === 'needs_verification').reduce((s, h) => s + h.households, 0);
    out.push({
      area,
      priority,
      verification: unverified / dn > 0.5 ? 'needs_verification' : 'verified',
      households: n,
      helpReplies: hs.reduce((s, h) => s + h.helpReplies, 0),
      smsSent: hs.reduce((s, h) => s + h.counts.smsSent, 0),
      smsReplies: hs.reduce((s, h) => s + h.counts.smsReplies, 0),
      claims: hs.reduce((s, h) => s + h.counts.claims, 0),
      expectedClaims: hs.reduce((s, h) => s + h.expectedClaims, 0),
      fieldReports: hs.reduce((s, h) => s + h.counts.fieldReports, 0),
      expectedSevere: hs.reduce((s, h) => s + h.expectedSevere, 0),
      maxPNeedsHelp: Math.max(...hs.map((h) => h.maxPNeedsHelp)),
      silence: w((h) => h.silence),
      hazard: w((h) => h.hazard),
      confidence: w((h) => h.confidence),
      severity: Math.max(...hs.map((h) => h.severity)),
    });
  }
  return out;
}

export const byUrgency = (a: AreaView, b: AreaView) =>
  RANK[a.priority] - RANK[b.priority] || b.helpReplies - a.helpReplies || b.severity - a.severity;

export const bySilence = (a: AreaView, b: AreaView) =>
  b.silence * b.hazard - a.silence * a.hazard;
