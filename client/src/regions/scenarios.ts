// Two synthetic disaster scenarios on real geography. The hazard models are
// deliberately simple and seeded: they only need to produce believable,
// irregular footprints. Nothing here is a real event or real damage data.
import type { MultiPolygon } from 'polygon-clipping';
import sfLand from './land/sf-peninsula.json';
import ccLand from './land/corpus-christi.json';

export type ScenarioId = 'sf-peninsula' | 'corpus-christi';

export interface Scenario {
  id: ScenarioId;
  name: string;
  hazard: 'earthquake' | 'hurricane';
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  land: MultiPolygon;
  field: (lng: number, lat: number) => number;
  threshold: number;
  unit: string;
  summary: string;
  extra: { label: string; points: [number, number][] }[]; // e.g. fault rupture, storm track ([lng, lat])
}

type GeoJsonish = { geometries?: { type: string; coordinates: unknown }[]; features?: { geometry: { type: string; coordinates: unknown } }[] };
function landOf(g: GeoJsonish): MultiPolygon {
  const geom = g.geometries?.[0] ?? g.features![0].geometry;
  return (geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates]) as MultiPolygon;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Local km projection around a reference point.
function projector(lat0: number, lng0: number) {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  return (lng: number, lat: number): [number, number] => [(lng - lng0) * kx, (lat - lat0) * ky];
}

// Smooth random bumps so contours wiggle like real hazard maps.
function noiseField(r: () => number, bbox: Scenario['bbox'], n: number, amp: number, radiusKm: [number, number]) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const P = projector((minLat + maxLat) / 2, (minLng + maxLng) / 2);
  const blobs = Array.from({ length: n }, () => {
    const [x, y] = P(minLng + r() * (maxLng - minLng), minLat + r() * (maxLat - minLat));
    const rad = radiusKm[0] + r() * (radiusKm[1] - radiusKm[0]);
    return { x, y, rad, a: (r() * 2 - 1) * amp };
  });
  return (lng: number, lat: number) => {
    const [x, y] = P(lng, lat);
    let v = 0;
    for (const b of blobs) v += b.a * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (b.rad * b.rad));
    return v;
  };
}

function distToPolyline(p: [number, number], line: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / (vx * vx + vy * vy)));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * vx), p[1] - (ay + t * vy)));
  }
  return best;
}

// Sub-section of a polyline between fractions [f0, f1] of its length.
function slice(line: [number, number][], f0: number, f1: number): [number, number][] {
  const seg = line.slice(1).map((b, i) => Math.hypot(b[0] - line[i][0], b[1] - line[i][1]));
  const total = seg.reduce((a, b) => a + b, 0);
  const at = (f: number): [number, number] => {
    let d = f * total;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i]) {
        const t = d / seg[i];
        return [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])];
      }
      d -= seg[i];
    }
    return line[line.length - 1];
  };
  const out: [number, number][] = [at(f0)];
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    acc += seg[i];
    if (acc / total > f0 && acc / total < f1) out.push(line[i + 1]);
  }
  out.push(at(f1));
  return out;
}

// San Andreas fault trace along the Peninsula, approximate ([lng, lat]).
const SAN_ANDREAS: [number, number][] = [
  [-122.6, 37.8], [-122.494, 37.667], [-122.415, 37.58], [-122.34, 37.5], [-122.255, 37.43], [-122.19, 37.37],
];

function sfPeninsula(seed: number): Scenario {
  const r = rng(seed);
  const bbox: Scenario['bbox'] = [-122.56, 37.25, -121.95, 37.84];
  const P = projector(37.6, -122.4);
  const f0 = 0.22 + r() * 0.2;
  const rupture = slice(SAN_ANDREAS, f0, f0 + 0.3 + r() * 0.15);
  const ruptureKm = rupture.map(([lng, lat]) => P(lng, lat));
  const M = 6.6 + r() * 0.4;
  const noise = noiseField(r, bbox, 14, 0.35, [2, 5]);
  // Soft bay-margin fill amplifies shaking: a band along the bay shore.
  const bayShore: [number, number][] = [P(-122.39, 37.71), P(-122.3, 37.56), P(-122.2, 37.48), P(-122.1, 37.44)];
  const field = (lng: number, lat: number) => {
    const p = P(lng, lat);
    const d = distToPolyline(p, ruptureKm);
    const mmi = 3.66 + 1.08 * M - 3.2 * Math.log10(Math.sqrt(d * d + 49));
    const site = 0.7 * Math.exp(-((distToPolyline(p, bayShore) / 2.5) ** 2));
    return mmi + site + noise(lng, lat);
  };
  return {
    id: 'sf-peninsula',
    name: 'San Francisco Peninsula',
    hazard: 'earthquake',
    bbox,
    land: landOf(sfLand as GeoJsonish),
    field,
    threshold: 7.5,
    unit: 'MMI',
    summary: `Synthetic M${M.toFixed(1)} on the San Andreas · footprint = shaking ≥ MMI 7.5`,
    extra: [{ label: 'Rupture', points: rupture }],
  };
}

function corpusChristi(seed: number): Scenario {
  const r = rng(seed);
  const bbox: Scenario['bbox'] = [-97.85, 27.3, -96.75, 28.3];
  const landfall: [number, number] = [-97.12 + (r() - 0.5) * 0.12, 27.74 + (r() - 0.5) * 0.14];
  const P = projector(landfall[1], landfall[0]);
  const heading = ((300 + r() * 35) * Math.PI) / 180; // compass bearing, toward NW
  const ux = Math.sin(heading);
  const uy = Math.cos(heading);
  const vmax = 130 + r() * 20;
  const R = 18 + r() * 8;
  const noise = (lng: number, lat: number) => coarse(lng, lat) + fine(lng, lat);
  const coarse = noiseField(r, bbox, 18, 6, [8, 16]);
  const fine = noiseField(r, bbox, 40, 5, [2, 5]);
  const field = (lng: number, lat: number) => {
    const [x, y] = P(lng, lat);
    const along = x * ux + y * uy;       // km past landfall (negative = offshore)
    const across = x * uy - y * ux;      // + = right of track
    const side = 0.9 + 0.1 * Math.tanh(across / 12); // stronger right of track, smoothly
    const inland = along > 0 ? Math.exp(-along / 110) : 1;
    // Gaussian across-track profile → rounded, parabola-like swath instead of a wedge.
    return 35 + (vmax - 35) * Math.exp(-((across / R) ** 2)) * side * inland + noise(lng, lat);
  };
  const toLngLat = (km: number): [number, number] => [
    landfall[0] + (km * ux) / (111.32 * Math.cos((landfall[1] * Math.PI) / 180)),
    landfall[1] + (km * uy) / 110.57,
  ];
  return {
    id: 'corpus-christi',
    name: 'Corpus Christi, TX',
    hazard: 'hurricane',
    bbox,
    land: landOf(ccLand as GeoJsonish),
    field,
    threshold: 96,
    unit: 'mph',
    summary: `Synthetic ${Math.round(vmax)} mph hurricane · footprint = winds ≥ 96 mph (Cat 2+)`,
    extra: [{ label: 'Track', points: [toLngLat(-40), toLngLat(70)] }],
  };
}

export function makeScenario(id: ScenarioId, seed: number): Scenario {
  return id === 'sf-peninsula' ? sfPeninsula(seed) : corpusChristi(seed);
}
