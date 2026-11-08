// Scenario definitions. Hurricanes are hypothetical (synthetic tracks over the real coastline);
// earthquakes use real USGS ShakeMap scenario grids. Households/events are always synthetic.

export interface HurricaneScenario {
  kind: 'hurricane';
  eventId: string;
  name: string;
  seed: number;
  landfallIso: string;
  landfall: { lat: number; lng: number };
  headingDeg: number;      // direction of motion, degrees clockwise from north (negative = toward the west)
  vmaxMph: number;         // max sustained wind at landfall
  rmaxKm: number;          // radius of maximum wind
  forwardKmh: number;      // forward speed (inland decay timing)
  surgeFt: number;         // peak storm-tide height at the open coast, right of track
  surgeInlandKm: number;   // e-folding distance of the water level inland from the OSM coastline
  rainFt: number;          // amplitude of rain-driven flood pockets in low-lying cells
  extraOutageClusters: number;
}

export interface QuakeScenario {
  kind: 'earthquake';
  eventId: string;
  name: string;
  seed: number;
  landfallIso: string;     // event origin time (synthetic); local hour / weekday are derived from it
  usgsEventId: string;
  extraOutageClusters: number;
}

export type Scenario = HurricaneScenario | QuakeScenario;

export const TX_SCENARIOS: HurricaneScenario[] = [
  {
    kind: 'hurricane', eventId: 'live', name: 'Hypothetical Cat-4 hurricane, Corpus Christi, TX', seed: 48355001,
    landfallIso: '2026-11-07T08:00:00.000Z', landfall: { lat: 27.615, lng: -97.205 }, headingDeg: -45,
    vmaxMph: 132, rmaxKm: 14, forwardKmh: 18, surgeFt: 14, surgeInlandKm: 4.0, rainFt: 2.4, extraOutageClusters: 2,
  },
  {
    kind: 'hurricane', eventId: 'backtest-1', name: 'Hypothetical Cat-2 hurricane, Port Aransas landfall', seed: 48355101,
    landfallIso: '2019-09-14T07:00:00.000Z', landfall: { lat: 27.80, lng: -97.07 }, headingDeg: -62,
    vmaxMph: 104, rmaxKm: 22, forwardKmh: 16, surgeFt: 7, surgeInlandKm: 2.5, rainFt: 2.0, extraOutageClusters: 2,
  },
  {
    kind: 'hurricane', eventId: 'backtest-2', name: 'Hypothetical Cat-4 hurricane, south Padre Island landfall', seed: 48355202,
    landfallIso: '2020-08-27T03:30:00.000Z', landfall: { lat: 27.45, lng: -97.29 }, headingDeg: -18,
    vmaxMph: 145, rmaxKm: 12, forwardKmh: 20, surgeFt: 15, surgeInlandKm: 4.0, rainFt: 2.5, extraOutageClusters: 3,
  },
  {
    kind: 'hurricane', eventId: 'backtest-3', name: 'Hypothetical Cat-1 hurricane, slow westward track', seed: 48355303,
    landfallIso: '2021-09-02T22:00:00.000Z', landfall: { lat: 27.70, lng: -97.16 }, headingDeg: -78,
    vmaxMph: 88, rmaxKm: 26, forwardKmh: 9, surgeFt: 5, surgeInlandKm: 2.0, rainFt: 3.2, extraOutageClusters: 2,
  },
];

export const CA_SCENARIOS: QuakeScenario[] = [
  {
    kind: 'earthquake', eventId: 'live', name: 'HayWired M7.05 Hayward Fault scenario (USGS ShakeMap), Alameda County, CA', seed: 6001001,
    landfallIso: '2026-11-06T18:40:00.000Z', usgsEventId: 'gllegacyhaywiredm7p05_se', extraOutageClusters: 2,
  },
  {
    kind: 'earthquake', eventId: 'backtest-1', name: 'San Andreas (Peninsula) M7.38 scenario (USGS ShakeMap)', seed: 6001101,
    landfallIso: '2019-03-12T10:42:00.000Z', usgsEventId: 'bssc2014sanandreaspeninsula2_m7p38_se', extraOutageClusters: 2,
  },
  {
    kind: 'earthquake', eventId: 'backtest-2', name: 'Calaveras North+Central M7.0 scenario (USGS ShakeMap)', seed: 6001202,
    landfallIso: '2021-06-03T19:05:00.000Z', usgsEventId: 'nclegacycalaverascnccm7p0_se', extraOutageClusters: 2,
  },
  {
    kind: 'earthquake', eventId: 'backtest-3', name: 'Hayward (South segment) M7.0 scenario (USGS ShakeMap)', seed: 6001303,
    landfallIso: '2023-10-21T03:30:00.000Z', usgsEventId: 'bssc2014haywardso2011cfmellb_m7p_se', extraOutageClusters: 2,
  },
];
