// Builds the static part of a real-geography world: study cells (H3 res 8) with real demographic,
// LODES, coastline, elevation and liquefaction attributes, synthetic households sampled from real
// tract shares, and real facilities. Hazard and events are added per scenario in simulate.ts.

import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import type { Facility, HexId, Household } from '../../shared/types.ts';
import type { Block, RegionData, Tract } from './load.ts';
import { Coastline, KM_PER_DEG_LAT, Projection, Terrain, inPolys } from './geo.ts';
import { Rng, subSeed } from '../src/rng.ts';

export const H3_RES = 8;
export const MIN_HH = 5; // minimum estimated real households for a cell to enter the study area

export interface CellInfo {
  hex: HexId;
  lat: number; lng: number;
  x: number; y: number;           // local km
  pop: number;                    // ACS-scaled population estimate
  households: number;             // ACS-scaled household estimate
  tract: string;                  // tract contributing most population
  jobs: number;                   // LODES WAC
  workers: number;                // LODES RAC
  coastKm: number;                // distance to OSM coastline (km)
  elevM: number;                  // mean ground elevation (m), NaN if unknown
  liquefaction: number;           // 0-1 share of sample points inside CGS liquefaction zones (CA)
  blocks: Block[];
}

export interface BaseWorld {
  cells: CellInfo[];
  cellByHex: Map<HexId, CellInfo>;
  proj: Projection;
  coast: Coastline;
  terrain: Terrain;
  facilities: Facility[];
  masts: Array<{ lat: number; lng: number; hex: HexId; x: number; y: number }>;
  notes: string[];
}

/** Approximate Hayward Fault surface trace (digitized by hand from public fault maps; used ONLY to
 *  select the study corridor, never for hazard - hazard comes from USGS ShakeMap). */
export const HAYWARD_TRACE: Array<[number, number]> = [
  [37.935, -122.305], [37.872, -122.245], [37.835, -122.215], [37.790, -122.180], [37.740, -122.135],
  [37.680, -122.085], [37.600, -122.025], [37.555, -121.975], [37.500, -121.930], [37.455, -121.895],
];

function signedDistToPolyline(proj: Projection, line: Array<[number, number]>, x: number, y: number): number {
  let best = Infinity, sign = 1;
  for (let i = 0; i + 1 < line.length; i++) {
    const ax = proj.x(line[i]![1]), ay = proj.y(line[i]![0]), bx = proj.x(line[i + 1]![1]), by = proj.y(line[i + 1]![0]);
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) { best = d; sign = dx * (y - ay) - dy * (x - ax) > 0 ? 1 : -1; }
  }
  // Trace runs north -> south, so "left" (positive cross) is east of the fault.
  return sign * best; // + east (hills side), - west (bay side)
}

export function buildBaseWorld(data: RegionData): BaseWorld {
  const r = data.region;
  const proj = new Projection(r.center.lat, r.center.lng);
  const coast = new Coastline(data.coastWays, proj);
  const terrain = new Terrain();
  const notes: string[] = [];
  const [s, w, n, e] = r.bbox;

  // ---- aggregate blocks to cells ----
  const byHex = new Map<HexId, Block[]>();
  for (const b of data.blocks) {
    if (b.lat < s || b.lat > n || b.lng < w || b.lng > e) continue;
    const h = latLngToCell(b.lat, b.lng, H3_RES);
    if (!byHex.has(h)) byHex.set(h, []);
    byHex.get(h)!.push(b);
  }
  const tractScale = (t: Tract | undefined) => (t && t.pop2020 > 0 ? t.pop / t.pop2020 : 1);
  const hhPerHu = (t: Tract | undefined) => (t && t.housingUnits > 0 && t.households > 0 ? t.households / t.housingUnits : 0.9);
  const candidates: CellInfo[] = [];
  for (const [hex, blocks] of byHex) {
    let pop = 0, hh = 0, jobs = 0, workers = 0;
    const byTract = new Map<string, number>();
    for (const b of blocks) {
      const t = data.tracts.get(b.tract);
      const p = b.pop2020 * tractScale(t);
      pop += p;
      hh += b.hu2020 * hhPerHu(t);
      jobs += b.jobs; workers += b.workers;
      byTract.set(b.tract, (byTract.get(b.tract) ?? 0) + p + 1e-6 * b.hu2020);
    }
    const [lat, lng] = cellToLatLng(hex);
    const tract = [...byTract.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    candidates.push({ hex, lat, lng, x: proj.x(lng), y: proj.y(lat), pop, households: hh, tract, jobs, workers, coastKm: 0, elevM: NaN, liquefaction: 0, blocks });
  }

  // ---- region-specific study area ----
  let pool = candidates;
  if (r.id === 'ca-bay-area') {
    pool = candidates.filter((c) => {
      const d = signedDistToPolyline(proj, HAYWARD_TRACE, c.x, c.y);
      return d <= 3.5 && d >= -9.5 && c.lat <= 37.905;
    });
    notes.push('Study corridor: Alameda County blocks within 9.5 km west / 3.5 km east of an approximate, hand-digitized Hayward Fault trace (selection only).');
  } else {
    notes.push('Study area: Nueces County blocks inside the Corpus Christi bounding box (city core, Flour Bluff, North Padre Island, Mustang Island / Port Aransas).');
  }
  // Keep the most populated cells, dropping near-empty ones (industrial land, parks, water).
  pool = pool.filter((c) => c.households >= MIN_HH);
  pool.sort((a, b) => b.households - a.households || (a.hex < b.hex ? -1 : 1));
  if (pool.length > r.targetCells) pool = pool.slice(0, r.targetCells);
  pool.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  notes.push(`Cells kept: ${pool.length} H3 res-8 cells with >= ${MIN_HH} estimated households (capped at the ${r.targetCells} most populated).`);

  for (const c of pool) {
    c.coastKm = coast.n ? coast.nearest(c.x, c.y).km : 99;
    c.elevM = terrain.meanElevation(c.lat, c.lng);
    if (data.liquefaction) {
      // share of 7 sample points (centre + ring at ~300 m) inside CGS liquefaction zones
      const kx = 111.32 * Math.cos((c.lat * Math.PI) / 180);
      let inside = 0;
      for (let k = 0; k < 7; k++) {
        const a = (k * Math.PI) / 3, rr = k === 0 ? 0 : 0.3;
        if (inPolys(data.liquefaction, c.lng + (rr * Math.cos(a)) / kx, c.lat + (rr * Math.sin(a)) / KM_PER_DEG_LAT)) inside++;
      }
      c.liquefaction = inside / 7;
    }
  }
  if (r.hazardType === 'earthquake' && !data.liquefaction) {
    // Documented proxy: low, flat land close to the bay shoreline.
    for (const c of pool) {
      const low = Number.isFinite(c.elevM) ? Math.max(0, Math.min(1, (12 - c.elevM) / 10)) : 0.3;
      c.liquefaction = Math.round(100 * low * Math.exp(-c.coastKm / 2.5)) / 100;
    }
  }
  const cellByHex = new Map(pool.map((c) => [c.hex, c]));

  // ---- facilities and masts inside the study cells ----
  const facilities: Facility[] = [];
  const seen = new Set<string>();
  const sorted = data.facilities.slice().sort((a, b) => (a.kind + a.name + a.sourceId < b.kind + b.name + b.sourceId ? -1 : 1));
  const counters: Record<string, number> = {};
  for (const f of sorted) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
    const hex = latLngToCell(f.lat, f.lng, H3_RES);
    if (!cellByHex.has(hex)) continue;
    const key = `${f.kind}|${f.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counters[f.kind] = (counters[f.kind] ?? 0) + 1;
    const fac: Facility = {
      id: `${r.id}-${f.kind}-${String(counters[f.kind]).padStart(3, '0')}`,
      kind: f.kind, name: f.name, lat: round(f.lat, 6), lng: round(f.lng, 6), hex, source: f.source,
    };
    if (f.enrollment !== undefined) fac.enrollment = f.enrollment;
    facilities.push(fac);
  }
  const masts = data.masts
    .map((m) => ({ lat: m.lat, lng: m.lng, hex: latLngToCell(m.lat, m.lng, H3_RES), x: proj.x(m.lng), y: proj.y(m.lat) }))
    .filter((m) => cellByHex.has(m.hex) || pool.some((c) => Math.hypot(c.x - m.x, c.y - m.y) < 2));

  return { cells: pool, cellByHex, proj, coast, terrain, facilities, masts, notes };
}

export const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function pickWeighted(rng: Rng, weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  let u = rng.float() * total;
  for (const [k, v] of entries) { u -= v; if (u <= 0) return k; }
  return entries[entries.length - 1]![0];
}

export interface HouseholdOptions {
  eventId: string;
  seed: number;
  households: number;
  holdoutShare: number;
  /** Probability of an earthquake endorsement (assumption) and flood-policy model. */
  hazardType: 'hurricane' | 'earthquake';
}

/** Hidden per-household attributes used by truth generation (not part of the contract). */
export interface HiddenAttrs { olderBuilding: boolean; vulnerable: boolean }

/**
 * Sample synthetic households. Cell counts are proportional to the ACS-scaled population estimate
 * (largest-remainder allocation, at least 1 per cell); each household sits near a real 2020 block
 * internal point chosen with probability proportional to block population.
 */
export function sampleHouseholds(base: BaseWorld, data: RegionData, opt: HouseholdOptions): { households: Household[]; hidden: Map<string, HiddenAttrs> } {
  const placeRng = new Rng(subSeed(opt.seed, 'place'));
  const attrRng = new Rng(subSeed(opt.seed, 'attrs'));
  const cells = base.cells;
  const totalPop = cells.reduce((a, c) => a + c.pop, 0);
  const rest = opt.households - cells.length;
  const raw = cells.map((c) => (c.pop / totalPop) * rest);
  const counts = raw.map((v) => 1 + Math.floor(v));
  let deficit = opt.households - counts.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; deficit > 0; k = (k + 1) % order.length, deficit--) counts[order[k]![1]]! += 1;

  const households: Household[] = [];
  const hidden = new Map<string, HiddenAttrs>();
  let seq = 0;
  cells.forEach((c, i) => {
    const kx = 111.32 * Math.cos((c.lat * Math.PI) / 180);
    const blocks = c.blocks.filter((b) => b.pop2020 > 0);
    const bw = blocks.map((b) => b.pop2020);
    const bTot = bw.reduce((a, b) => a + b, 0);
    const workersPerHh = c.households > 0 ? c.workers / c.households : 1;
    for (let k = 0; k < counts[i]!; k++) {
      let block: Block | undefined;
      if (bTot > 0) {
        let u = placeRng.float() * bTot;
        for (let j = 0; j < blocks.length; j++) { u -= bw[j]!; if (u <= 0) { block = blocks[j]; break; } }
        block ??= blocks[blocks.length - 1];
      }
      let lat = block?.lat ?? c.lat, lng = block?.lng ?? c.lng;
      for (let attempt = 0; attempt < 10; attempt++) {
        const rr = 0.12 * Math.sqrt(placeRng.float());
        const a = placeRng.range(0, 2 * Math.PI);
        const la = lat + (rr * Math.sin(a)) / KM_PER_DEG_LAT, ln = lng + (rr * Math.cos(a)) / kx;
        if (latLngToCell(la, ln, H3_RES) === c.hex) { lat = la; lng = ln; break; }
      }
      if (latLngToCell(lat, lng, H3_RES) !== c.hex) { lat = c.lat; lng = c.lng; }
      const tractId = block?.tract ?? c.tract;
      const t = data.tracts.get(tractId)!;
      seq++;
      // ---- attributes from real tract shares ----
      const age65 = attrRng.chance(t.shareHh65);
      const age75 = age65 && attrRng.chance(t.share75Of65);
      const aloneNon65 = clamp((t.shareAlone - t.shareHh65 * t.shareAlone65OfHh65) / Math.max(0.05, 1 - t.shareHh65), 0, 0.9);
      const livesAlone = attrRng.chance(age65 ? t.shareAlone65OfHh65 : aloneNon65);
      // children: none if alone; 65+ households 0.35x as likely (assumption); rescaled so the tract share holds.
      const a65 = t.shareHh65 * (1 - t.shareAlone65OfHh65), bNon = (1 - t.shareHh65) * (1 - aloneNon65);
      const pKids = clamp(t.shareHhKids / Math.max(0.05, 0.35 * a65 + bNon), 0, 0.95);
      const childrenUnder18 = !livesAlone && attrRng.chance(age65 ? 0.35 * pKids : pKids);
      // disability: 65+ households use the 65+ person rate; others 1-(1-p)^2 for ~2 adults (assumption)
      const disability = attrRng.chance(age65 ? (livesAlone ? t.disab65 : 1 - (1 - t.disab65) ** 1.5) : 1 - (1 - t.disabU65) ** 2);
      const noVehicle = attrRng.chance(clamp(t.shareNoVehicle * (age65 ? 1.4 : 0.9) * (livesAlone ? 1.5 : 1), 0, 0.9));
      const mobileHome = attrRng.chance(t.shareMobile);
      // language group from C16002, concrete language from C16001 person splits
      const group = pickWeighted(attrRng, t.lang) as keyof Tract['lang'];
      let primaryLanguage = 'en';
      let limitedEnglish = false;
      if (group !== 'en') {
        limitedEnglish = attrRng.chance(t.limited[group]);
        primaryLanguage = group === 'es' ? 'es' : group === 'api' ? pickWeighted(attrRng, t.apiSplit) : group === 'ie' ? pickWeighted(attrRng, t.ieSplit) : pickWeighted(attrRng, t.otherSplit);
      }
      // medical device: no public tract data; old-sim rates (assumption) scaled by SVI disability rate.
      const disRatio = t.pctDisabled !== undefined ? clamp(t.pctDisabled / 13, 0.5, 2) : 1;
      const medicalDevice = attrRng.chance((age65 ? 0.09 : 0.0275) * disRatio);
      // away in the daytime: LODES resident workers per household (assumption: ~1.8 adults per non-senior household)
      const awayDaytime = attrRng.chance(clamp((workersPerHh / 1.8) * (age65 ? 0.3 : 1) * (childrenUnder18 ? 0.85 : 1), 0.03, 0.85));
      const windCovered = attrRng.chance(0.97);
      const floodPolicy = opt.hazardType === 'hurricane'
        ? attrRng.chance(clamp(0.06 + 0.5 * Math.exp(-c.coastKm / 2.5) + (Number.isFinite(c.elevM) && c.elevM < 3 ? 0.1 : 0), 0, 0.8))
        : attrRng.chance(0.02);
      const earthquakeEndorsement = attrRng.chance(opt.hazardType === 'earthquake' ? 0.12 : 0.02);
      const phoneOnFile = attrRng.chance(0.88);
      const id = `${opt.eventId}-h${String(seq).padStart(6, '0')}`;
      households.push({
        id, hex: c.hex, lat: round(lat, 6), lng: round(lng, 6),
        age65, livesAlone, medicalDevice, windCovered, floodPolicy, earthquakeEndorsement, phoneOnFile,
        holdout: false,
        tractGeoid: tractId, childrenUnder18, awayDaytime,
        age75, disability, noVehicle, limitedEnglish, primaryLanguage, mobileHome,
      });
      hidden.set(id, { olderBuilding: attrRng.chance(t.sharePre1980), vulnerable: attrRng.chance(0.06) });
    }
  });
  const holdoutCount = Math.round(opt.holdoutShare * households.length);
  for (const hh of attrRng.shuffle(households).slice(0, holdoutCount)) hh.holdout = true;
  return { households, hidden };
}

/** Neighbour lookup restricted to the study cells. */
export function ringIn(set: Set<HexId>, h: HexId, k: number): HexId[] {
  return gridDisk(h, k).filter((n) => set.has(n));
}
