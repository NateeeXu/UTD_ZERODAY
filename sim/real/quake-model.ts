// Parametric shaking for random (hypothetical) earthquakes, when no USGS ShakeMap grid exists:
// a finite rupture (straight segment along a fault, length from magnitude) and an intensity prediction
// equation (IPE) giving MMI from magnitude and distance to the rupture. Constants in QUAKE_MODEL are
// research decisions documented in docs/DATA.md (sources listed there).

export interface LatLng { lat: number; lng: number }

export interface QuakeModel {
  /** IPE: MMI = c1 + c2(M-6) + c3(M-6)^2 + c4 log10 R + c5 R + c6 B + c7 M log10 R,
   *  R = sqrt(D^2 + h^2) km, B = max(0, log10(R / Rt)) */
  ipe: { c1: number; c2: number; c3: number; c4: number; c5: number; c6: number; c7: number; h: number; Rt: number };
  /** surface rupture length: log10(L km) = a + b M */
  rupture: { a: number; b: number };
}

// Atkinson & Wald (2007) California IPE and Wells & Coppersmith (1994) strike-slip rupture length.
export const QUAKE_MODEL: QuakeModel = {
  ipe: { c1: 12.27, c2: 2.27, c3: 0.1304, c4: -1.3, c5: -0.0007070, c6: 1.95, c7: -0.577, h: 14.0, Rt: 30.0 },
  rupture: { a: -3.55, b: 0.74 },
};

export function ipeMmi(m: number, dKm: number, model: QuakeModel = QUAKE_MODEL): number {
  const { c1, c2, c3, c4, c5, c6, c7, h, Rt } = model.ipe;
  const r = Math.sqrt(dKm * dKm + h * h);
  const lr = Math.log10(r);
  const b = Math.max(0, Math.log10(r / Rt));
  return c1 + c2 * (m - 6) + c3 * (m - 6) ** 2 + c4 * lr + c5 * r + c6 * b + c7 * m * lr;
}

export function ruptureLengthKm(m: number, model: QuakeModel = QUAKE_MODEL): number {
  return 10 ** (model.rupture.a + model.rupture.b * m);
}

const KM_PER_DEG_LAT = 111.32;

/** Rupture segment of the given length centred on the epicentre along the strike (degrees clockwise from north). */
export function ruptureSegment(epi: LatLng, strikeDeg: number, lengthKm: number): [LatLng, LatLng] {
  const half = lengthKm / 2;
  const th = (strikeDeg * Math.PI) / 180;
  const kmLng = KM_PER_DEG_LAT * Math.cos((epi.lat * Math.PI) / 180);
  const dLat = (half * Math.cos(th)) / KM_PER_DEG_LAT;
  const dLng = (half * Math.sin(th)) / kmLng;
  return [{ lat: epi.lat - dLat, lng: epi.lng - dLng }, { lat: epi.lat + dLat, lng: epi.lng + dLng }];
}

/** Horizontal distance (km) from p to segment ab (local equirectangular projection). */
export function distanceToSegmentKm(p: LatLng, a: LatLng, b: LatLng): number {
  const kmLng = KM_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lng - p.lng) * kmLng, ay = (a.lat - p.lat) * KM_PER_DEG_LAT;
  const bx = (b.lng - p.lng) * kmLng, by = (b.lat - p.lat) * KM_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}
