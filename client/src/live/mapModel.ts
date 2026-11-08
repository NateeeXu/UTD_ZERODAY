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
      .filter(isSuspected)
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
  rep: number;
  sent: number;
  cl: number;
  fr: number;
  si: number;          // silence of the most silent high-hazard child
  sc: string;          // its silence cause
  r: string;           // reason of the top child
  shape: [number, number][][] | [number, number][][][]; // Leaflet [lat, lng]
  center: [number, number];
}

export function unitsFor(cells: readonly HexStatsRow[], res: 7 | 8): MapUnit[] {
  if (res === 8) {
    return cells.map((c) => ({
      id: c.hex, res, kids: [c], p: prio(c.priority), v: c.verification === 'verified' ? 'verified' : 'needs_verification',
      c: c.confidence, n: c.households, ex: c.expectedSevere, rep: c.smsReplies, sent: c.smsSent, cl: c.claims, fr: c.fieldReports,
      si: c.silence, sc: c.silenceCause, r: c.reason,
      shape: [cellToBoundary(c.hex) as [number, number][]], center: cellToLatLng(c.hex) as [number, number],
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
    const centers = kids.map((k) => cellToLatLng(k.hex));
    out.push({
      id, res, kids, n,
      p: prio(top.priority),
      v: needs ? 'needs_verification' : 'verified',
      c: kids.reduce((s, k) => s + w(k) * k.confidence, 0),
      ex: Math.round(kids.reduce((s, k) => s + k.expectedSevere, 0) * 10) / 10,
      rep: kids.reduce((s, k) => s + k.smsReplies, 0),
      sent: kids.reduce((s, k) => s + k.smsSent, 0),
      cl: kids.reduce((s, k) => s + k.claims, 0),
      fr: kids.reduce((s, k) => s + k.fieldReports, 0),
      si: silentKid.silence, sc: silentKid.silenceCause,
      r: top.reason,
      shape: cellsToMultiPolygon(kids.map((k) => k.hex)) as [number, number][][][],
      center: [centers.reduce((s, c) => s + c[0], 0) / centers.length, centers.reduce((s, c) => s + c[1], 0) / centers.length],
    });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function tooltipHtml(u: MapUnit, label: string): string {
  const cause = u.sc && u.si >= 0.2 ? `<br>Silence: ${Math.round(u.si * 100)}% · ${esc(CAUSE[u.sc] ?? u.sc)}` : '';
  const scope = u.res === 7 ? `District of ${u.kids.length} neighborhoods · ` : '';
  return (
    `<b>${esc(label)} · ${u.p}${u.v === 'needs_verification' ? ' · needs verification' : ' · verified'}</b>` +
    `<br>${scope}Confidence ${Math.round(u.c * 100)}% · ${u.n.toLocaleString()} households · ~${u.ex.toFixed(1)} likely severe` +
    `<br>SMS replies ${u.rep}/${u.sent} · claims ${u.cl}${u.fr ? ` · field reports ${u.fr}` : ''}${cause}` +
    (u.r ? `<br><span class="tip-reason">${esc(u.r)}</span>` : '')
  );
}
