// Builds an irregular disaster region and tiles it with H3 hexagons.
//
//   hazard field ──contour(threshold)──▶ footprint
//   footprint ∩ land (Census shoreline) ──▶ region
//   region ──H3 res 8──▶ interior cells (whole hexes) + boundary cells (clipped)
//
// Frontend-only demo for now (not part of shared/types.ts); see regions/README.md.
import { contours } from 'd3-contour';
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import {
  POLYGON_TO_CELLS_FLAGS, UNITS, cellArea, cellToBoundary, cellToLatLng, gridDisk, polygonToCellsExperimental,
} from 'h3-js';
import type { Scenario } from './scenarios';

export const REGION_RES = 8;
const MIN_PIECE = 0.04; // clipped bits smaller than 4% of a hex get merged into a neighbour
const MIN_ISLAND_KM2 = 0.3;

export interface RegionCell {
  hex: string;
  clipped: boolean;
  areaFrac: number;        // share of the full hex that is inside the region
  geometry: MultiPolygon;  // [lng, lat] rings
  intensity: number;       // hazard at the cell center (mph or MMI)
}

export interface Region {
  scenario: Scenario;
  footprint: MultiPolygon; // hazard contour, before the coastline cut
  region: MultiPolygon;    // footprint ∩ land
  cells: RegionCell[];
  mergedSlivers: number;   // tiny clipped bits folded into a neighbouring cell
  isolatedSlivers: number; // tiny bits with no neighbour, kept as their own cell
}

// Planar area in km² of a [lng, lat] ring set (fine at city scale).
function ringArea(r: Ring, lat0: number): number {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += (r[j][0] * kx) * (r[i][1] * ky) - (r[i][0] * kx) * (r[j][1] * ky);
  }
  return Math.abs(a) / 2;
}
export function multiArea(mp: MultiPolygon, lat0: number): number {
  return mp.reduce((s, poly) => s + ringArea(poly[0], lat0) - poly.slice(1).reduce((h, r) => h + ringArea(r, lat0), 0), 0);
}

function contourFootprint(s: Scenario): MultiPolygon {
  const [minLng, minLat, maxLng, maxLat] = s.bbox;
  const nx = 260;
  const ny = Math.round(nx * ((maxLat - minLat) / ((maxLng - minLng) * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180))));
  const dx = (maxLng - minLng) / nx;
  const dy = (maxLat - minLat) / ny;
  const values = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const lat = maxLat - (y + 0.5) * dy;
    for (let x = 0; x < nx; x++) values[x + y * nx] = s.field(minLng + (x + 0.5) * dx, lat);
  }
  const [c] = contours().size([nx, ny]).thresholds([s.threshold])(Array.from(values));
  // Grid space → lng/lat (row 0 is the north edge).
  return c.coordinates.map((poly) =>
    poly.map((ring) => ring.map(([x, y]) => [minLng + x * dx, maxLat - y * dy] as [number, number])),
  ) as MultiPolygon;
}

export function buildRegion(s: Scenario): Region {
  const footprint = contourFootprint(s);
  const lat0 = (s.bbox[1] + s.bbox[3]) / 2;
  // Drop tiny land pieces (spoil islands, piers): smaller than ~0.4 of a hex.
  const region = polygonClipping.intersection(footprint, s.land).filter((poly) => multiArea([poly], lat0) >= MIN_ISLAND_KM2);

  const full = new Set<string>();
  const touching = new Set<string>();
  for (const poly of region) {
    const coords = poly as unknown as number[][][];
    for (const h of polygonToCellsExperimental(coords, REGION_RES, POLYGON_TO_CELLS_FLAGS.containmentFull, true)) full.add(h);
    for (const h of polygonToCellsExperimental(coords, REGION_RES, POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true)) touching.add(h);
  }

  // Pass 1: whole hexes, and clipped pieces big enough to click.
  const byHex = new Map<string, RegionCell>();
  const slivers: { hex: string; poly: Polygon; frac: number }[] = [];
  for (const hex of touching) {
    const ring = cellToBoundary(hex, true) as [number, number][];
    const [lat, lng] = cellToLatLng(hex);
    const intensity = s.field(lng, lat);
    if (full.has(hex)) {
      byHex.set(hex, { hex, clipped: false, areaFrac: 1, geometry: [[ring]], intensity });
      continue;
    }
    const hexKm2 = cellArea(hex, UNITS.km2);
    // A hex on the coast can overlap two separate land pieces; handle each part on its own.
    for (const poly of polygonClipping.intersection([ring] as Polygon, region)) {
      const frac = multiArea([poly], lat0) / hexKm2;
      if (frac < MIN_PIECE) {
        slivers.push({ hex, poly, frac });
        continue;
      }
      const c = byHex.get(hex);
      if (c) {
        c.geometry.push(poly);
        c.areaFrac += frac;
      } else {
        byHex.set(hex, { hex, clipped: true, areaFrac: frac, geometry: [poly], intensity });
      }
    }
  }

  // Pass 2: merge each sliver into a neighbouring cell it touches, so every bit of
  // affected land belongs to some clickable cell. Isolated slivers become their own cell.
  let mergedSlivers = 0;
  let isolatedSlivers = 0;
  for (const sl of slivers) {
    let merged = false;
    for (const n of gridDisk(sl.hex, 1)) {
      const c = n === sl.hex ? undefined : byHex.get(n);
      if (!c) continue;
      const u = polygonClipping.union(c.geometry, [sl.poly]);
      if (u.length <= c.geometry.length) { // touched → merged into one shape
        c.geometry = u;
        c.clipped = true;
        c.areaFrac += sl.frac;
        merged = true;
        break;
      }
    }
    if (merged) {
      mergedSlivers++;
      continue;
    }
    isolatedSlivers++;
    const own = byHex.get(sl.hex);
    if (own) {
      own.geometry.push(sl.poly);
      own.areaFrac += sl.frac;
    } else {
      const [lat, lng] = cellToLatLng(sl.hex);
      byHex.set(sl.hex, { hex: sl.hex, clipped: true, areaFrac: sl.frac, geometry: [sl.poly], intensity: s.field(lng, lat) });
    }
  }
  const cells = [...byHex.values()];
  for (const c of cells) c.areaFrac = Math.min(1, c.areaFrac);
  return { scenario: s, footprint, region, cells, mergedSlivers, isolatedSlivers };
}
