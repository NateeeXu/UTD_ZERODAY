// Map logic from docs/preview/map-preview.html (approved style A + C), on live hex_stats rows.
import { cellToBoundary, cellToLatLng, cellToParent, cellsToMultiPolygon } from 'h3-js';
import type { HexStatsRow } from './rows';

export type Priority = 'P0' | 'P1' | 'P2';
export const COLOR: Record<Priority, string> = { P0: '#d93a35', P1: '#ee7d2b', P2: '#e8b931' };
export const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
export const CAUSE: Record<string, string> = {
  outage: 'cell towers down',
  away: 'residents likely away at work',
  trapped: 'many vulnerable residents',
  unknown: 'cause unclear',
};
export const PULSE_TOP = 10;
export const LOD_ZOOM = 12;

export const prio = (p: string): Priority => (p === 'P0' || p === 'P1' ? p : 'P2');

// "Suspected P0": high hazard, high silence, not yet verified (spec C).
export const isSuspected = (c: HexStatsRow) =>
  c.priority === 'P0' && c.verification === 'needs_verification' && c.silence >= 0.5 && c.hazard >= 0.5;

export function pulsingCells(cells: readonly HexStatsRow[]): Set<string> {
  return new Set(
    cells
      // The pulse means "nobody has checked here yet": once an adjuster has reported in the cell it stops
      // (the cell keeps its priority colour if it is still urgent).
      .filter((c) => isSuspected(c) && c.fieldReports === 0 && c.verifiedHouseholds === 0)
      .sort((a, b) => b.silence * b.hazard * b.households - a.silence * a.hazard * a.households)
      .slice(0, PULSE_TOP)
      .map((c) => c.hex),
  );
}

export interface MapUnit {
  id: string;
  res: 7 | 8;
  kids: HexStatsRow[];
  p: Priority;
  v: 'verified' | 'needs_verification';
  c: number;           // confidence 0–1 (household-weighted for districts)
  n: number;           // households
  ex: number;          // expected severe
  lo: number;          // 90% range for severely damaged homes (districts: summed cell bounds)
  hi: number;
  rep: number;
  sent: number;
  cl: number;
  fr: number;
  si: number;          // silence of the most silent high-hazard child
  sc: string;          // its silence cause
  r: string;           // reason of the top child
  un: number;          // unaccounted households (no reply, claim or field report yet)
  uv: number;          // unaccounted vulnerable households
  shape: [number, number][][] | [number, number][][][]; // Leaflet [lat, lng]
  center: [number, number];
}

// Order-independent key for a set of cells (count + sum of string hashes). The cell set is not fixed:
// a new disaster replaces the world, and seeding streams hexes in batches of 500.
export function cellSetKey(cells: readonly { hex: string }[]): string {
  let sum = 0;
  for (const c of cells) {
    let h = 0;
    for (let i = 0; i < c.hex.length; i++) h = (h * 31 + c.hex.charCodeAt(i)) | 0;
    sum = (sum + h) | 0;
  }
  return `${cells.length}:${sum >>> 0}`;
}

// Geometry never changes for a given set of cells, so cache it: the replay recomputes units every
// second and cellsToMultiPolygon over every district is the expensive part. District keys include
// the exact child set, so a new world never reuses an old outline.
const shapeCache = new Map<string, { shape: MapUnit['shape']; center: [number, number] }>();
function cachedGeom(key: string, make: () => { shape: MapUnit['shape']; center: [number, number] }) {
  let g = shapeCache.get(key);
  if (!g) {
    if (shapeCache.size > 20000) shapeCache.clear();
    g = make();
    shapeCache.set(key, g);
  }
  return g;
}

export function unitsFor(cells: readonly HexStatsRow[], res: 7 | 8): MapUnit[] {
  if (res === 8) {
    return cells.map((c) => ({
      id: c.hex, res, kids: [c], p: prio(c.priority), v: c.verification === 'verified' ? 'verified' : 'needs_verification',
      c: c.confidence, n: c.households, ex: c.expectedSevere, lo: c.severeLo, hi: c.severeHi, rep: c.smsReplies, sent: c.smsSent, cl: c.claims, fr: c.fieldReports,
      si: c.silence, sc: c.silenceCause, r: c.reason, un: c.unaccounted, uv: c.unaccountedVulnerable,
      ...cachedGeom(c.hex, () => ({ shape: [cellToBoundary(c.hex) as [number, number][]], center: cellToLatLng(c.hex) as [number, number] })),
    }));
  }
  const groups = new Map<string, HexStatsRow[]>();
  for (const c of cells) {
    const p = cellToParent(c.hex, 7);
    const g = groups.get(p);
    if (g) g.push(c);
    else groups.set(p, [c]);
  }
  const out: MapUnit[] = [];
  for (const [id, kids] of groups) {
    const n = kids.reduce((s, k) => s + k.households, 0);
    const w = (k: HexStatsRow) => (n > 0 ? k.households / n : 1 / kids.length);
    const top = kids.reduce((a, b) =>
      RANK[prio(b.priority)] < RANK[prio(a.priority)] || (b.priority === a.priority && b.severity > a.severity) ? b : a);
    const needs = kids.some((k) => k.verification === 'needs_verification' && k.priority === top.priority);
    const silentKid = kids.reduce((a, b) => (b.silence * b.hazard > a.silence * a.hazard ? b : a));
    const geom = cachedGeom(`${id}:${cellSetKey(kids)}`, () => {
      const centers = kids.map((k) => cellToLatLng(k.hex));
      return {
        shape: cellsToMultiPolygon(kids.map((k) => k.hex)) as [number, number][][][],
        center: [centers.reduce((s, c) => s + c[0], 0) / centers.length, centers.reduce((s, c) => s + c[1], 0) / centers.length] as [number, number],
      };
    });
    out.push({
      id, res, kids, n,
      p: prio(top.priority),
      v: needs ? 'needs_verification' : 'verified',
      c: kids.reduce((s, k) => s + w(k) * k.confidence, 0),
      ex: Math.round(kids.reduce((s, k) => s + k.expectedSevere, 0) * 10) / 10,
      lo: kids.reduce((s, k) => s + k.severeLo, 0),
      hi: kids.reduce((s, k) => s + k.severeHi, 0),
      rep: kids.reduce((s, k) => s + k.smsReplies, 0),
      sent: kids.reduce((s, k) => s + k.smsSent, 0),
      cl: kids.reduce((s, k) => s + k.claims, 0),
      fr: kids.reduce((s, k) => s + k.fieldReports, 0),
      si: silentKid.silence, sc: silentKid.silenceCause,
      r: top.reason,
      un: kids.reduce((s, k) => s + k.unaccounted, 0),
      uv: kids.reduce((s, k) => s + k.unaccountedVulnerable, 0),
      ...geom,
    });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

// One plain sentence for *why* this area has its priority, from the engine's reason
// (first clause) and the structured fields. Silence only shows when it is the driver.
export function driverLine(u: MapUnit): string {
  const first = (u.r.split(';')[0] ?? '').trim();
  const silentDriver = u.p === 'P0' && u.v === 'needs_verification' && u.si >= 0.5 && /suspected|silent/i.test(first);
  if (silentDriver || /^suspected/i.test(first)) {
    const cause = CAUSE[u.sc] ?? 'cause unclear';
    return u.sent > 0 ? `Silent: ${u.rep} of ${u.sent} replied · ${cause}` : `Silent high-hazard area · ${cause}`;
  }
  let m = first.match(/(\d+) households? confirmed needing help/);
  if (m) return `${m[1]} resident${m[1] === '1' ? '' : 's'} confirmed needing help`;
  m = first.match(/credible needs-help signal \(max (\d+)%\)/);
  if (m) return `Residents asking for help (up to ${m[1]}%)`;
  m = first.match(/possible needs-help \(max (\d+)%\)/);
  if (m) return `Possible help requests (up to ${m[1]}%)`;
  if (/no policyholders/.test(first)) return 'No policyholders here';
  const share = u.n > 0 ? u.ex / u.n : 0;
  if (u.p === 'P2') return share >= 0.1 ? `Some damage expected (~${Math.round(share * 100)}% of homes)` : 'Little damage expected';
  return `Heavy damage expected (~${Math.round(share * 100)}% of homes)`;
}

// "6–11" from the cell's 90% range; "~8" when a source has no range (preview snapshot).
export function severeRange(u: Pick<MapUnit, 'lo' | 'hi' | 'ex'>): string {
  if (Number.isFinite(u.lo) && Number.isFinite(u.hi)) {
    const lo = Math.round(u.lo);
    const hi = Math.round(u.hi);
    return lo === hi ? lo.toLocaleString() : `${lo.toLocaleString()}–${hi.toLocaleString()}`;
  }
  return `~${Math.round(u.ex).toLocaleString()}`;
}

export function tooltipHtml(u: MapUnit, label: string): string {
  const status = u.fr > 0 ? 'field-verified' : u.v === 'verified' ? 'verified' : 'unverified';
  return (
    `<div class="tip-title"><i style="background:${COLOR[u.p]}"></i>${esc(label)} · ${u.p}` +
    `<span class="tip-status ${u.v === 'verified' ? 'ok' : ''}">${status}</span></div>` +
    `<div class="tip-why">${esc(driverLine(u))}</div>` +
    `<div class="tip-meta">${u.n.toLocaleString()} homes · ${severeRange(u)} severely damaged · ${Math.round(u.c * 100)}% confident</div>` +
    (Number.isFinite(u.un)
      ? `<div class="tip-unacc${u.un > 0 ? '' : ' done'}">Unaccounted ${u.un.toLocaleString()} of ${u.n.toLocaleString()} · vulnerable unaccounted ${u.uv.toLocaleString()}</div>`
      : '')
  );
}

export type MapMode = 'priority' | 'unaccounted';

// Style A: opacity carries the second dimension. Priority mode → confidence; Unaccounted mode → share not heard from.
export function intensity(u: MapUnit, mode: MapMode): number {
  if (mode === 'unaccounted') return u.n > 0 && Number.isFinite(u.un) ? u.un / u.n : 0;
  return u.c;
}
