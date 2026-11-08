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

// Verified against NHC NWS-NHC-6, HURDAT2 (55 Texas landfalls, 1851-2025), NHC reports (Harvey, Hanna, Bret,
// Claudette), NWS Corpus Christi / Lake Charles (Celia, Carla, Allen). No Cat 5 has made landfall in Texas:
// Cat 5 is kept as a 1 % tail scenario. Cat 2 and Cat 5 surge ranges are interpolated (unverified).
// surgeInlandKm and rainFt are in this simulator's own units and stay within the range of the calibrated
// backtest scenarios (sim/real/scenarios.ts), not physical attenuation rates.
export const HURRICANE_SPEC: HurricaneSpec = {
  categories: {
    '1': { p: 0.42, vmaxMph: [74, 95], rmaxKm: [15, 65], surgeFt: [3, 7] },
    '2': { p: 0.25, vmaxMph: [96, 110], rmaxKm: [18, 55], surgeFt: [6, 11] },
    '3': { p: 0.19, vmaxMph: [111, 129], rmaxKm: [18, 55], surgeFt: [8, 15] },
    '4': { p: 0.13, vmaxMph: [130, 156], rmaxKm: [15, 45], surgeFt: [10, 22] },
    '5': { p: 0.01, vmaxMph: [157, 175], rmaxKm: [12, 35], surgeFt: [16, 28] },
  },
  forwardKmh: { min: 6, mode: 15, max: 32 },
  headingDeg: { min: -110, mode: -55, max: -5 },
  landfallLat: [27.3, 28.1],
  surgeInlandKm: [2.0, 4.5],
  rainFt: { min: 1.0, max: 3.2, slowBoostBelowKmh: 12, slowBoost: 1.3 },
};

// Fault traces: vertices from the USGS Quaternary fault database. Weights: USGS 2014-2043 Bay Area chance of
// M>=6.7 (33/26/22/16/6 %), Greenville 3 % (2003 USGS estimate), Mount Diablo thrust 3 % (unverified);
// the sampler normalises them. Max magnitudes derived from segment length (Wells & Coppersmith 1994).
// San Andreas: the USGS straight line runs from Mendocino to the Peninsula; trimmed here to its southern
// 40 % (Peninsula + Golden Gate + Marin), the part that can strongly shake Alameda County.
export const QUAKE_SPEC: QuakeSpec = {
  faults: [
    { name: 'Hayward', a: { lat: 37.4471, lng: -121.8761 }, b: { lat: 38.0039, lng: -122.3675 }, magnitude: [6.0, 7.2], weight: 0.33 },
    { name: 'Calaveras', a: { lat: 36.9855, lng: -121.4641 }, b: { lat: 37.8484, lng: -122.0415 }, magnitude: [6.0, 7.4], weight: 0.26 },
    { name: 'San Andreas (Peninsula + Golden Gate)', a: { lat: 37.2682, lng: -122.102 }, b: { lat: 37.964, lng: -122.739 }, magnitude: [6.5, 7.8], weight: 0.22 },
    { name: 'Concord-Green Valley', a: { lat: 37.9007, lng: -121.9901 }, b: { lat: 38.5485, lng: -122.2474 }, magnitude: [6.0, 7.2], weight: 0.16 },
    { name: 'San Gregorio', a: { lat: 37.0718, lng: -122.2622 }, b: { lat: 37.5582, lng: -122.5169 }, magnitude: [6.0, 7.1], weight: 0.06 },
    { name: 'Greenville', a: { lat: 37.4197, lng: -121.5022 }, b: { lat: 37.975, lng: -121.9636 }, magnitude: [6.0, 7.2], weight: 0.03 },
    { name: 'Mount Diablo thrust', a: { lat: 37.73, lng: -121.8239 }, b: { lat: 37.877, lng: -122.0398 }, magnitude: [5.5, 6.7], weight: 0.03 },
  ],
  depthKm: [3, 13],
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

/**
 * Named presets "inspired by" real events (hypothetical, not reconstructions). Values from HURDAT2, NHC
 * tropical cyclone reports, NWS Corpus Christi and USGS scenario / event pages; (est.) = estimated.
 * Celia: current best track gives 120 kt (Cat 4) although NWS pages disagree (Cat 3-4); rain (est.).
 * Harvey: surge and rain amplitude are (est.) mappings of 4-10 ft inundation and 60 in of rain.
 * Hanna: real landfall 26.8 N, moved north to 27.3 N to fall inside the region; lng and rain (est.).
 * 1868 Hayward: real time 7:53 am Wednesday, moved to 3 am for a night-time case; depth (est.).
 */
export const HURRICANE_PRESETS: HurricanePreset[] = [
  { id: 'celia-type-direct-hit', name: 'Compact Cat 4 direct hit', analog: 'Celia 1970 (small, fast major hurricane through Port Aransas; extreme winds across Corpus Christi)',
    landfall: { lat: 27.8, lng: -97.1 }, headingDeg: -67, category: 4, vmaxMph: 138, rmaxKm: 18.5, forwardKmh: 28, surgeFt: 9.2, rainFt: 0.8, localHour: 16, weekday: true },
  { id: 'harvey-type-stall', name: 'Stalling Cat 4 deluge', analog: 'Harvey 2017 (Cat 4 at Rockport that crawled and stalled; catastrophic rain)',
    landfall: { lat: 28.0, lng: -96.9 }, headingDeg: -33, category: 4, vmaxMph: 132, rmaxKm: 18.5, forwardKmh: 9, surgeFt: 7, rainFt: 4.0, localHour: 22, weekday: true },
  { id: 'hanna-type-cat1', name: 'Cat 1 weekend landfall', analog: 'Hanna 2020 (weaker Cat 1 on Padre Island; moderate surge into Corpus Christi Bay)',
    landfall: { lat: 27.3, lng: -97.36 }, headingDeg: -103, category: 1, vmaxMph: 92, rmaxKm: 37, forwardKmh: 13, surgeFt: 5.4, rainFt: 1.5, localHour: 17, weekday: false },
];
export const QUAKE_PRESETS: QuakePreset[] = [
  { id: 'haywired-m705', name: 'HayWired M7.05 under Oakland', analog: 'the USGS HayWired scenario (official Hayward-fault planning scenario)', faultName: 'Hayward',
    epicenter: { lat: 37.8046, lng: -122.1786 }, magnitude: 7.05, strikeDeg: 326, depthKm: 8, localHour: 16, weekday: true },
  { id: 'hayward-1868-night', name: '1868 Hayward repeat at night', analog: 'the 1868 Hayward earthquake (last major rupture of the southern Hayward fault; real time 7:53 am)', faultName: 'Hayward',
    epicenter: { lat: 37.7, lng: -122.1 }, magnitude: 6.8, strikeDeg: 322, depthKm: 8, localHour: 3, weekday: true },
  { id: 'calaveras-north-m686', name: 'Northern Calaveras M6.9, Pleasanton', analog: 'the USGS BSSC2014 northern Calaveras scenario (locked eastern fault under the I-680 corridor)', faultName: 'Calaveras',
    epicenter: { lat: 37.6508, lng: -121.9311 }, magnitude: 6.86, strikeDeg: 335, depthKm: 10.4, localHour: 14, weekday: false },
];
