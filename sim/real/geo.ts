// Geometry helpers: local projection, coastline distance/side, point-in-polygon, raster sampling.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.ts';
import type { Rgb } from './png.ts';
import { RAW_DIR, TERRAIN_ZOOM, latToTileY, lngToTileX } from './sources.ts';

export const KM_PER_DEG_LAT = 110.574;

export class Projection {
  readonly lat0: number;
  readonly lng0: number;
  readonly kx: number;
  constructor(lat0: number, lng0: number) {
    this.lat0 = lat0;
    this.lng0 = lng0;
    this.kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  }
  x(lng: number): number { return (lng - this.lng0) * this.kx; }
  y(lat: number): number { return (lat - this.lat0) * KM_PER_DEG_LAT; }
  lng(x: number): number { return this.lng0 + x / this.kx; }
  lat(y: number): number { return this.lat0 + y / KM_PER_DEG_LAT; }
}

/** OSM natural=coastline segments in local km. OSM convention: land is on the LEFT of the way direction. */
export class Coastline {
  private ax: Float64Array; private ay: Float64Array; private bx: Float64Array; private by: Float64Array;
  readonly n: number;
  constructor(ways: Array<Array<{ lat: number; lon: number }>>, proj: Projection) {
    const segs: number[] = [];
    for (const w of ways) {
      for (let i = 0; i + 1 < w.length; i++) {
        segs.push(proj.x(w[i]!.lon), proj.y(w[i]!.lat), proj.x(w[i + 1]!.lon), proj.y(w[i + 1]!.lat));
      }
    }
    this.n = segs.length / 4;
    this.ax = new Float64Array(this.n); this.ay = new Float64Array(this.n);
    this.bx = new Float64Array(this.n); this.by = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.ax[i] = segs[4 * i]!; this.ay[i] = segs[4 * i + 1]!; this.bx[i] = segs[4 * i + 2]!; this.by[i] = segs[4 * i + 3]!;
    }
  }
  /** Distance (km) to the nearest coastline segment, the nearest point, and whether (x,y) is on land. */
  nearest(x: number, y: number): { km: number; land: boolean; px: number; py: number } {
    let best = Infinity, bi = -1, bt = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = this.bx[i]! - this.ax[i]!, dy = this.by[i]! - this.ay[i]!;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - this.ax[i]!) * dx + (y - this.ay[i]!) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = this.ax[i]! + t * dx - x, qy = this.ay[i]! + t * dy - y;
      const d2 = qx * qx + qy * qy;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    if (bi < 0) return { km: 99, land: true, px: x, py: y };
    const dx = this.bx[bi]! - this.ax[bi]!, dy = this.by[bi]! - this.ay[bi]!;
    const px = this.ax[bi]! + bt * dx, py = this.ay[bi]! + bt * dy;
    // Side test against the segment direction; at a vertex (t=0 or 1) this can be ambiguous, so use
    // the vector from the nearest point when it is not degenerate.
    const cross = dx * (y - this.ay[bi]!) - dy * (x - this.ax[bi]!);
    return { km: Math.sqrt(best), land: cross > 0, px, py };
  }
}

type Ring = number[][];
function inRing(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!, xj = ring[j]![0]!, yj = ring[j]![1]!;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export interface PolyIndex { polys: Ring[][]; boxes: number[][] }
export function buildPolyIndex(geojson: { features: Array<{ geometry: { type: string; coordinates: unknown } }> }): PolyIndex {
  const polys: Ring[][] = [];
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates as Ring[]);
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates as Ring[][]) polys.push(p);
  }
  const boxes = polys.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of p[0]!) { a = Math.min(a, x!); b = Math.min(b, y!); c = Math.max(c, x!); d = Math.max(d, y!); }
    return [a, b, c, d];
  });
  return { polys, boxes };
}
export function inPolys(idx: PolyIndex, lng: number, lat: number): boolean {
  for (let k = 0; k < idx.polys.length; k++) {
    const bx = idx.boxes[k]!;
    if (lng < bx[0]! || lng > bx[2]! || lat < bx[1]! || lat > bx[3]!) continue;
    const p = idx.polys[k]!;
    if (inRing(p[0]!, lng, lat) && !p.slice(1).some((h) => inRing(h, lng, lat))) return true;
  }
  return false;
}

/** Elevation (m) from cached Terrarium tiles; returns NaN if the tile is missing. */
export class Terrain {
  private cache = new Map<string, Rgb | null>();
  private tile(x: number, y: number): Rgb | null {
    const key = `${x}_${y}`;
    if (!this.cache.has(key)) {
      const p = join(RAW_DIR, 'elev', `terrarium_${TERRAIN_ZOOM}_${x}_${y}.png`);
      this.cache.set(key, existsSync(p) ? decodePng(readFileSync(p)) : null);
    }
    return this.cache.get(key)!;
  }
  elevation(lat: number, lng: number): number {
    const fx = lngToTileX(lng, TERRAIN_ZOOM), fy = latToTileY(lat, TERRAIN_ZOOM);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const img = this.tile(tx, ty);
    if (!img) return NaN;
    const px = Math.min(img.width - 1, Math.floor((fx - tx) * img.width));
    const py = Math.min(img.height - 1, Math.floor((fy - ty) * img.height));
    const i = (py * img.width + px) * img.channels;
    return img.data[i]! * 256 + img.data[i + 1]! + img.data[i + 2]! / 256 - 32768;
  }
  /** Mean elevation over a few points around (lat,lng) within ~r km. */
  meanElevation(lat: number, lng: number, rKm = 0.25): number {
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    const pts: Array<[number, number]> = [[0, 0]];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      pts.push([(rKm * Math.sin(a)) / KM_PER_DEG_LAT, (rKm * Math.cos(a)) / kx]);
    }
    const v = pts.map(([dy, dx]) => this.elevation(lat + dy, lng + dx)).filter((e) => Number.isFinite(e));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  }
}

/** Regular lon/lat grid with bilinear interpolation (ShakeMap grid.xml). */
export class LonLatGrid {
  readonly lonMin: number; readonly latMax: number; readonly dLon: number; readonly dLat: number;
  readonly nLon: number; readonly nLat: number; readonly values: Float32Array;
  constructor(lonMin: number, latMax: number, dLon: number, dLat: number, nLon: number, nLat: number, values: Float32Array) {
    this.lonMin = lonMin; this.latMax = latMax; this.dLon = dLon; this.dLat = dLat;
    this.nLon = nLon; this.nLat = nLat; this.values = values;
  }
  sample(lat: number, lng: number): number {
    const fx = (lng - this.lonMin) / this.dLon;
    const fy = (this.latMax - lat) / this.dLat;
    const x0 = Math.max(0, Math.min(this.nLon - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(this.nLat - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const v = (x: number, y: number) => this.values[y * this.nLon + x]!;
    return (1 - ty) * ((1 - tx) * v(x0, y0) + tx * v(x0 + 1, y0)) + ty * ((1 - tx) * v(x0, y0 + 1) + tx * v(x0 + 1, y0 + 1));
  }
}

/** Parse a ShakeMap grid.xml and return the MMI grid plus event metadata. */
export function parseShakeMapGrid(xml: string): { grid: LonLatGrid; magnitude: number; lat: number; lon: number; description: string; timestamp: string } {
  const attr = (tag: string, name: string): string => {
    const m = new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`).exec(xml);
    if (!m) throw new Error(`grid.xml missing ${tag}@${name}`);
    return m[1]!;
  };
  const nLon = Number(attr('grid_specification', 'nlon'));
  const nLat = Number(attr('grid_specification', 'nlat'));
  const lonMin = Number(attr('grid_specification', 'lon_min'));
  const latMax = Number(attr('grid_specification', 'lat_max'));
  const dLon = Number(attr('grid_specification', 'nominal_lon_spacing'));
  const dLat = Number(attr('grid_specification', 'nominal_lat_spacing'));
  const fields = [...xml.matchAll(/<grid_field index="(\d+)" name="([A-Z0-9_]+)"/g)];
  const mmiCol = Number(fields.find((f) => f[2] === 'MMI')![1]) - 1;
  const body = xml.slice(xml.indexOf('<grid_data>') + 11, xml.indexOf('</grid_data>'));
  const values = new Float32Array(nLon * nLat);
  let k = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    values[k++] = Number(parts[mmiCol]);
  }
  if (k !== nLon * nLat) throw new Error(`grid.xml has ${k} rows, expected ${nLon * nLat}`);
  return {
    grid: new LonLatGrid(lonMin, latMax, dLon, dLat, nLon, nLat, values),
    magnitude: Number(attr('event', 'magnitude')),
    lat: Number(attr('event', 'lat')),
    lon: Number(attr('event', 'lon')),
    description: attr('event', 'event_description'),
    timestamp: attr('event', 'event_timestamp'),
  };
}
