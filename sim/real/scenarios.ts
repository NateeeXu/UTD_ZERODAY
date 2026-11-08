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
  /** USGS ShakeMap scenario grid (data/raw/usgs/grid_<id>.xml); or `parametric` for a random event */
  usgsEventId?: string;
  parametric?: { faultName: string; epicenter: { lat: number; lng: number }; magnitude: number; strikeDeg: number; depthKm: number };
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
  {
    kind: 'hurricane', eventId: 'backtest-4', name: 'Hypothetical Cat-3 hurricane, Mustang Island landfall', seed: 48355404,
    landfallIso: '2017-08-26T03:00:00.000Z', landfall: { lat: 27.72, lng: -97.12 }, headingDeg: -35,
    vmaxMph: 120, rmaxKm: 16, forwardKmh: 12, surgeFt: 11, surgeInlandKm: 3.5, rainFt: 3.0, extraOutageClusters: 3,
  },
  {
    kind: 'hurricane', eventId: 'backtest-5', name: 'Hypothetical Cat-1 hurricane, Baffin Bay landfall', seed: 48355505,
    landfallIso: '2018-07-20T15:30:00.000Z', landfall: { lat: 27.30, lng: -97.36 }, headingDeg: -10,
    vmaxMph: 85, rmaxKm: 28, forwardKmh: 22, surgeFt: 4, surgeInlandKm: 1.8, rainFt: 1.8, extraOutageClusters: 1,
  },
  {
    kind: 'hurricane', eventId: 'backtest-6', name: 'Hypothetical Cat-2 hurricane, Matagorda Island track', seed: 48355606,
    landfallIso: '2016-09-08T11:15:00.000Z', landfall: { lat: 28.10, lng: -96.80 }, headingDeg: -70,
    vmaxMph: 100, rmaxKm: 20, forwardKmh: 14, surgeFt: 8, surgeInlandKm: 3.0, rainFt: 2.2, extraOutageClusters: 2,
  },
  {
    kind: 'hurricane', eventId: 'backtest-7', name: 'Hypothetical Cat-4 hurricane, North Padre Island landfall', seed: 48355707,
    landfallIso: '2015-10-01T23:45:00.000Z', landfall: { lat: 27.55, lng: -97.24 }, headingDeg: -50,
    vmaxMph: 150, rmaxKm: 11, forwardKmh: 17, surgeFt: 16, surgeInlandKm: 4.2, rainFt: 2.6, extraOutageClusters: 3,
  },
  {
    kind: 'hurricane', eventId: 'backtest-8', name: 'Hypothetical Cat-2 hurricane, slow stall over Copano Bay', seed: 48355808,
    landfallIso: '2014-08-30T06:00:00.000Z', landfall: { lat: 27.98, lng: -97.02 }, headingDeg: -80,
    vmaxMph: 96, rmaxKm: 24, forwardKmh: 7, surgeFt: 7, surgeInlandKm: 2.6, rainFt: 3.6, extraOutageClusters: 2,
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
  // Added so the training range covers the severity of the live HayWired world (strong MMI 8.5-10 on the corridor).
  {
    kind: 'earthquake', eventId: 'backtest-4', name: 'Hayward + Rodgers Creek (RC+HN+HS+HE) M7.58 scenario (USGS ShakeMap)', seed: 6001404,
    landfallIso: '2022-01-15T09:20:00.000Z', usgsEventId: 'bssc2014haywardrchnhsheshaw0_m7p58_se', extraOutageClusters: 3,
  },
  {
    kind: 'earthquake', eventId: 'backtest-5', name: 'Hayward North+South+Extension (HN+HS+HE) M7.36 scenario (USGS ShakeMap)', seed: 6001505,
    landfallIso: '2024-04-16T21:10:00.000Z', usgsEventId: 'bssc2014haywardhnhsheshaw09m_m7p36_se', extraOutageClusters: 2,
  },
];
