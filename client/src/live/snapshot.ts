// Read-only stand-in for regions whose live database isn't published yet:
// A's approved preview snapshots (docs/preview/preview-data.js), shaped like
// live rows so the same map and panels render them.
import type { FacilityRow, HexStatsRow } from './rows';

interface SnapCell {
  hex: string; p: string; v: string; c: number; s: number; si: number; hz: number;
  sc: string | null; r: string; n: number; ex: number; rep: number; sent: number; cl: number;
}
interface SnapRegion {
  title: string; subtitle: string; hazardType: string; eventLocalHour?: number; eventWeekday?: boolean;
  households: number; cells: number; modelVersion: number;
  snapshots: Record<string, SnapCell[]>;
  facilities: { k: string; n: string; lat: number; lng: number; e: number | null }[];
}
export interface PreviewData { times: number[]; regions: Record<'tx' | 'ca', SnapRegion> }

// Lazy: ~800 KB, only fetched when a snapshot region is opened.
const files = import.meta.glob('../../../docs/preview/preview-data.js');
let cache: Promise<PreviewData | null> | null = null;
export function loadPreview(): Promise<PreviewData | null> {
  if (!cache) {
    const loader = Object.values(files)[0];
    cache = loader
      ? loader().then(() => (window as unknown as { PREVIEW_DATA?: PreviewData }).PREVIEW_DATA ?? null)
      : Promise.resolve(null);
  }
  return cache;
}

export function snapshotRows(cells: SnapCell[]): HexStatsRow[] {
  return cells.map((c) => ({
    hex: c.hex, priority: c.p, verification: c.v, confidence: c.c, severity: c.s, silence: c.si, hazard: c.hz,
    silenceCause: c.sc ?? '', reason: c.r, households: c.n, expectedSevere: c.ex, smsReplies: c.rep, smsSent: c.sent,
    claims: c.cl, fieldReports: 0, unaccounted: Number.NaN, unaccountedVulnerable: Number.NaN, // not in the preview data
  }) as unknown as HexStatsRow);
}

export function snapshotFacilities(r: SnapRegion): FacilityRow[] {
  return r.facilities.map((f, i) => ({
    id: `${f.k}-${i}`, kind: f.k, name: f.n, lat: f.lat, lng: f.lng, hex: '', enrollment: f.e ?? undefined, capacity: undefined, source: 'preview',
  }) as unknown as FacilityRow);
}
