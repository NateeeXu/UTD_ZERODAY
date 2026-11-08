// Sampling spec for random (hypothetical) disasters and named presets for judges.
// Values are research decisions; sources and caveats are listed in docs/DATA.md ("Random disasters").

export interface Range { min: number; max: number }
export interface Tri { min: number; mode: number; max: number }

export interface HurricaneSpec {
  categories: Record<'1' | '2' | '3' | '4' | '5', { p: number; vmaxMph: [number, number]; rmaxKm: [number, number]; surgeFt: [number, number] }>;
  forwardKmh: Tri;
  headingDeg: Tri;
  landfallLat: [number, number];
  /** in this simulator's units (e-folding distance of the water level inland from the OSM coastline) */
  surgeInlandKm: [number, number];
  rainFt: { min: number; max: number; slowBoostBelowKmh: number; slowBoost: number };
}

export interface FaultSpec {
  name: string;
  a: { lat: number; lng: number };
  b: { lat: number; lng: number };
  magnitude: [number, number];
  weight: number;
}

export interface QuakeSpec {
  faults: FaultSpec[];
  depthKm: [number, number];
}

export const HURRICANE_SPEC: HurricaneSpec = {
  categories: {
    '1': { p: 0.42, vmaxMph: [74, 95], rmaxKm: [25, 60], surgeFt: [3, 7] },
    '2': { p: 0.26, vmaxMph: [96, 110], rmaxKm: [22, 50], surgeFt: [6, 11] },
    '3': { p: 0.2, vmaxMph: [111, 129], rmaxKm: [18, 40], surgeFt: [9, 16] },
    '4': { p: 0.1, vmaxMph: [130, 156], rmaxKm: [14, 32], surgeFt: [12, 20] },
    '5': { p: 0.02, vmaxMph: [157, 170], rmaxKm: [10, 25], surgeFt: [16, 24] },
  },
  forwardKmh: { min: 5, mode: 17, max: 30 },
  headingDeg: { min: -80, mode: -50, max: -15 },
  landfallLat: [27.3, 28.1],
  surgeInlandKm: [2.0, 4.5],
  rainFt: { min: 1.0, max: 3.2, slowBoostBelowKmh: 12, slowBoost: 1.3 },
};

export const QUAKE_SPEC: QuakeSpec = {
  faults: [
    { name: 'Hayward', a: { lat: 37.47, lng: -121.93 }, b: { lat: 37.97, lng: -122.33 }, magnitude: [6.4, 7.1], weight: 0.33 },
    { name: 'Calaveras', a: { lat: 37.17, lng: -121.58 }, b: { lat: 37.77, lng: -121.96 }, magnitude: [6.0, 6.9], weight: 0.25 },
    { name: 'San Andreas (Peninsula)', a: { lat: 37.15, lng: -122.03 }, b: { lat: 37.72, lng: -122.52 }, magnitude: [6.8, 7.8], weight: 0.2 },
    { name: 'Concord-Green Valley', a: { lat: 37.92, lng: -122.03 }, b: { lat: 38.3, lng: -122.18 }, magnitude: [6.0, 6.8], weight: 0.12 },
    { name: 'Greenville', a: { lat: 37.47, lng: -121.62 }, b: { lat: 37.85, lng: -121.87 }, magnitude: [6.0, 6.9], weight: 0.1 },
  ],
  depthKm: [8, 12],
};

export interface HurricanePreset {
  id: string; name: string; analog: string;
  landfall: { lat: number; lng: number }; headingDeg: number; category: number; vmaxMph: number; rmaxKm: number;
  forwardKmh: number; surgeFt: number; rainFt: number; localHour: number; weekday: boolean;
}
export interface QuakePreset {
  id: string; name: string; analog: string; faultName: string;
  epicenter: { lat: number; lng: number }; magnitude: number; strikeDeg: number; depthKm: number; localHour: number; weekday: boolean;
}

/** Named presets "inspired by" real events (hypothetical, not reconstructions). */
export const HURRICANE_PRESETS: HurricanePreset[] = [];
export const QUAKE_PRESETS: QuakePreset[] = [];
